#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline/promises";
import { styleText } from "node:util";
import { spawnSync } from "node:child_process";
import { Database } from "node:sqlite";

const timer = performance.now();

const DB_PATH = path.join(import.meta.dirname, "db", "tracktomb.db");

const TAG_COLUMNS = {
  title: ["TITLE"],
  artist: ["ARTIST"],
  album: ["ALBUM"],
  albumartist: ["ALBUMARTIST", "ALBUM ARTIST"],
  tracknumber: ["TRACKNUMBER", "TRACK"],
  tracktotal: ["TRACKTOTAL", "TOTALTRACKS"],
  discnumber: ["DISCNUMBER", "DISC"],
  disctotal: ["DISCTOTAL", "TOTALDISCS"],
  date: ["DATE", "YEAR"],
  genre: ["GENRE"],
  composer: ["COMPOSER"],
  record_label: ["LABEL", "ORGANIZATION", "PUBLISHER"],
  isrc: ["ISRC"],
  barcode: ["BARCODE", "UPC"],
  copyright: ["COPYRIGHT"],
  comment: ["COMMENT", "DESCRIPTION"],
  mediatype: ["MEDIATYPE"],
  itunesadvisory: ["ITUNESADVISORY"],
  replaygain_track_gain: ["REPLAYGAIN_TRACK_GAIN"],
  replaygain_track_peak: ["REPLAYGAIN_TRACK_PEAK"],
  replaygain_album_gain: ["REPLAYGAIN_ALBUM_GAIN"],
  replaygain_album_peak: ["REPLAYGAIN_ALBUM_PEAK"],
  musicbrainz_trackid: ["MUSICBRAINZ_TRACKID"],
  musicbrainz_albumid: ["MUSICBRAINZ_ALBUMID"],
  musicbrainz_artistid: ["MUSICBRAINZ_ARTISTID"],
};

// tags that describe the album: stored once in `albums`, the rest stay per track in `tracks`
const ALBUM_TAGS = [
  "album",
  "albumartist",
  "date",
  "record_label",
  "barcode",
  "copyright",
  "mediatype",
  "tracktotal",
  "disctotal",
  "musicbrainz_albumid",
  "replaygain_album_gain",
  "replaygain_album_peak",
];

const TRACK_TAGS = Object.keys(TAG_COLUMNS).filter(
  (t) => !ALBUM_TAGS.includes(t),
);

// columns declared INTEGER: numeric-looking values are stored as numbers, anything else (e.g. "A1") stays text
const INTEGER_TAGS = [
  "tracknumber",
  "tracktotal",
  "discnumber",
  "disctotal",
  "itunesadvisory",
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS batches (
  id         INTEGER PRIMARY KEY,
  label      TEXT NOT NULL UNIQUE,   -- what you type at the prompt, e.g. "Batch 1"
  created_at TEXT NOT NULL           -- ISO 8601, UTC
);

CREATE TABLE IF NOT EXISTS albums (
  id        INTEGER PRIMARY KEY,
  batch_id  INTEGER NOT NULL REFERENCES batches(id),
  rel_path  TEXT NOT NULL,           -- album folder relative to the batch folder, forward slashes, "." if the batch folder is the album

  -- tags, first non-empty value among the album's tracks
  album TEXT, albumartist TEXT,
  date TEXT, record_label TEXT, barcode TEXT, copyright TEXT, mediatype TEXT,
  tracktotal INTEGER, disctotal INTEGER,   -- stay text if not numeric
  musicbrainz_albumid TEXT,
  replaygain_album_gain TEXT, replaygain_album_peak TEXT,

  created_at TEXT NOT NULL,

  UNIQUE (batch_id, rel_path)
);

CREATE TABLE IF NOT EXISTS tracks (
  id              INTEGER PRIMARY KEY,
  album_id        INTEGER NOT NULL REFERENCES albums(id),

  -- identity
  rel_path        TEXT NOT NULL,     -- relative to the album folder, forward slashes, e.g. "disc01/01.flac"
  size            INTEGER NOT NULL,  -- bytes
  mtime_ms        INTEGER NOT NULL,
  sha256          TEXT NOT NULL,     -- whole file
  streaminfo_md5  TEXT,              -- NULL if the encoder never set it

  -- audio
  sample_rate     INTEGER NOT NULL,
  channels        INTEGER NOT NULL,
  bits_per_sample INTEGER NOT NULL,
  total_samples   INTEGER NOT NULL,
  duration        INTEGER,           -- whole seconds, rounded

  -- tags
  title TEXT, artist TEXT,
  tracknumber INTEGER, discnumber INTEGER,   -- stay text if not numeric, e.g. "A1"
  genre TEXT, composer TEXT, isrc TEXT, comment TEXT,
  itunesadvisory INTEGER,                    -- 0 none, 1 explicit, 2 clean
  replaygain_track_gain TEXT, replaygain_track_peak TEXT,
  musicbrainz_trackid TEXT, musicbrainz_artistid TEXT,

  raw_tags   TEXT NOT NULL,          -- every tag exactly as in the file
  scanned_at TEXT NOT NULL,

  UNIQUE (album_id, rel_path, size, mtime_ms)   -- this is what makes re-runs resume
);

CREATE INDEX IF NOT EXISTS tracks_sha256 ON tracks (sha256);  -- finds duplicates across batches

-- everything that is not a flac (cover.jpg, .lrc, .cue, .log, pdf scans, ...): inventory only, contents are not stored
CREATE TABLE IF NOT EXISTS extras (
  id         INTEGER PRIMARY KEY,
  batch_id   INTEGER NOT NULL REFERENCES batches(id),
  album_id   INTEGER REFERENCES albums(id),   -- NULL for files outside any album folder

  rel_path   TEXT NOT NULL,          -- relative to the album folder (to the batch folder if album_id is NULL), forward slashes
  ext        TEXT NOT NULL,          -- lowercase with the dot, "" if none
  size       INTEGER NOT NULL,       -- bytes
  mtime_ms   INTEGER NOT NULL,
  sha256     TEXT NOT NULL,          -- whole file

  scanned_at TEXT NOT NULL
);

-- resume key; IFNULL because NULLs never collide in a plain UNIQUE constraint
CREATE UNIQUE INDEX IF NOT EXISTS extras_unique ON extras (batch_id, IFNULL(album_id, 0), rel_path, size, mtime_ms);
CREATE INDEX IF NOT EXISTS extras_album_id ON extras (album_id);
CREATE INDEX IF NOT EXISTS extras_sha256 ON extras (sha256);
`;

const ALBUM_COLUMNS = ["batch_id", "rel_path", ...ALBUM_TAGS, "created_at"];

const TRACK_COLUMNS = [
  "album_id",
  "rel_path",
  "size",
  "mtime_ms",
  "sha256",
  "streaminfo_md5",
  "sample_rate",
  "channels",
  "bits_per_sample",
  "total_samples",
  "duration",
  ...TRACK_TAGS,
  "raw_tags",
  "scanned_at",
];

const EXTRA_COLUMNS = [
  "batch_id",
  "album_id",
  "rel_path",
  "ext",
  "size",
  "mtime_ms",
  "sha256",
  "scanned_at",
];

const insertSql = (table, columns) =>
  `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((c) => `@${c}`).join(", ")})`;

const INSERT_ALBUM = insertSql("albums", ALBUM_COLUMNS);
const INSERT_TRACK = insertSql("tracks", TRACK_COLUMNS);
const INSERT_EXTRA = insertSql("extras", EXTRA_COLUMNS);

const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k]]));

// path of `to` relative to `from`, always with forward slashes
const toRel = (from, to) => path.relative(from, to).split(path.sep).join("/");

function scanDir(dir, files = [], skipped = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    skipped.push({ path: dir, error: err.code });
    return { files, skipped };
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) scanDir(full, files, skipped);
    else if (e.isFile()) files.push(full);
  }
  return { files, skipped };
}

// The album folder is the first-level folder of the batch folder; files sitting directly in the batch folder belong to the batch folder itself
function albumDirOf(file, sourceDir) {
  const [first, ...rest] = toRel(sourceDir, file).split("/");
  return rest.length > 0 ? path.join(sourceDir, first) : sourceDir;
}

// The album a file belongs to, or null if no flac was found in its album folder
function findAlbum(file, sourceDir, groups) {
  return groups.get(albumDirOf(file, sourceDir)) ?? null;
}

// metaflac on Windows can't open paths longer than 252 characters
function withShortPath(file, fn) {
  if (process.platform !== "win32" || file.length < 252) return fn(file);

  const temp = path.join(os.tmpdir(), `tracktomb-${process.pid}.flac`);
  fs.copyFileSync(file, temp);

  try {
    return fn(temp);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

// Runs metaflac on one file and returns its stdout, decoded as UTF-8. Callers pass --no-utf8-convert where text is involved, otherwise metaflac would transcode tags into the console code page and CJK characters become "?".
function metaflac(args, file) {
  const result = spawnSync("metaflac", [...args, file], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024, // big tags (lyrics, cuesheets) can make the output large
  });

  if (result.error) throw result.error; // metaflac missing / can't start

  if (result.status !== 0) {
    const exit = result.signal
      ? `terminated by ${result.signal}`
      : `exited with code ${result.status}`;
    throw new Error(result.stderr.trim() || `metaflac ${exit}`);
  }

  return result.stdout.replace(/\r\n/g, "\n");
}

// SHA-256 of the whole file, read in 1 MiB chunks so big files never sit in memory
function hashFile(file) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(file, "r");

  try {
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, bytesRead));
  } finally {
    fs.closeSync(fd);
  }

  return hash.digest("hex");
}

// "KEY=value" lines -> Map of UPPERCASED key -> [values]. Vorbis comment keys are case-insensitive and may repeat.
function parseTags(raw) {
  const tags = new Map();

  for (const line of raw.split("\n")) {
    const eq = line.indexOf("=");
    if (eq < 1) continue;

    const key = line.slice(0, eq).toUpperCase();
    if (!tags.has(key)) tags.set(key, []);
    tags.get(key).push(line.slice(eq + 1));
  }

  return tags;
}

// "7/12" -> ["7", "12"]; anything else comes back as [value, null]
function splitOf(value) {
  const match = value?.match(/^\s*(\d+)\s*\/\s*(\d+)\s*$/);
  return match ? [match[1], match[2]] : [value ?? null, null];
}

// One value per column: the first alias that has a non-empty value, repeated values joined with "; "
function extractTags(tags) {
  const columns = {};

  for (const [column, names] of Object.entries(TAG_COLUMNS)) {
    columns[column] = null;

    for (const name of names) {
      const value = tags
        .get(name)
        ?.filter((v) => v !== "")
        .join("; ");

      if (value) {
        columns[column] = value;
        break;
      }
    }
  }

  // "7/12" in TRACKNUMBER / DISCNUMBER: keep the number, and use the total when there is no total tag
  const [track, trackOf] = splitOf(columns.tracknumber);
  columns.tracknumber = track;
  columns.tracktotal ??= trackOf;

  const [disc, discOf] = splitOf(columns.discnumber);
  columns.discnumber = disc;
  columns.disctotal ??= discOf;

  // numbers as numbers, so "07" and "7" are the same value when album tags of different tracks are compared
  for (const column of INTEGER_TAGS) {
    const value = columns[column];

    if (/^\d+$/.test(value ?? "") && Number.isSafeInteger(Number(value)))
      columns[column] = Number(value);
  }

  return columns;
}

// Returns { album, track }: the album-level tags and everything that belongs in the tracks row
function catalogFile(item) {
  // metaflac first: a file that isn't valid FLAC fails here, before we read all of it for hashing
  const { info, rawTags } = withShortPath(item.path, (file) => ({
    info: metaflac(
      [
        "--show-sample-rate",
        "--show-channels",
        "--show-bps",
        "--show-total-samples",
        "--show-md5sum",
      ],
      file,
    ),
    rawTags: metaflac(["--no-utf8-convert", "--export-tags-to=-"], file),
  }));

  const lines = info.trim().split("\n");
  const numbers = lines.slice(0, 4);
  const md5 = lines[4];

  if (
    lines.length !== 5 ||
    !numbers.every((n) => /^\d+$/.test(n)) ||
    !/^[0-9a-f]{32}$/i.test(md5)
  )
    throw new Error(`Unexpected metaflac output: ${JSON.stringify(info)}`);

  const [sampleRate, channels, bitsPerSample, totalSamples] =
    numbers.map(Number);

  const sha256 = hashFile(item.path);
  const tags = extractTags(parseTags(rawTags));

  return {
    album: pick(tags, ALBUM_TAGS),
    track: {
      rel_path: item.rel,
      size: item.size,
      mtime_ms: item.mtimeMs,
      sha256,
      streaminfo_md5: /^0+$/.test(md5) ? null : md5.toLowerCase(), // all zeros = the encoder never set it
      sample_rate: sampleRate,
      channels,
      bits_per_sample: bitsPerSample,
      total_samples: totalSamples,
      duration: sampleRate > 0 ? Math.round(totalSamples / sampleRate) : null,
      ...pick(tags, TRACK_TAGS),
      raw_tags: rawTags,
    },
  };
}

function inventoryExtra(item) {
  return {
    rel_path: item.rel,
    ext: path.extname(item.path).toLowerCase(),
    size: item.size,
    mtime_ms: item.mtimeMs,
    sha256: hashFile(item.path),
  };
}

// Stats the files and splits them into new ones (todo) and ones already recorded, so re-runs resume. item.rel is relative to baseDir (what goes in the database), item.display to the batch folder (what is printed).
function planFiles(paths, baseDir, sourceDir, isRecorded, failed) {
  const todo = [];
  let recorded = 0;

  for (const file of paths) {
    const display = toRel(sourceDir, file);

    try {
      const stat = fs.statSync(file);
      const item = {
        path: file,
        display,
        rel: toRel(baseDir, file),
        size: stat.size,
        mtimeMs: Math.floor(stat.mtimeMs),
      };

      if (isRecorded(item)) recorded++;
      else todo.push(item);
    } catch (err) {
      failed.push({ path: file, error: err.message });
      console.log(styleText("red", `[-] Failed ${display}`));
    }
  }

  return { todo, recorded };
}

// Builds a record for each item and saves it; every save commits on its own, so an interrupted run keeps everything finished so far
function runItems({ todo, build, save, verb, failed }) {
  let added = 0;

  for (const item of todo) {
    let record;

    try {
      record = build(item);
    } catch (err) {
      failed.push({ path: item.path, error: err.message });
      console.log(styleText("red", `[-] Failed ${item.display}`));
      continue;
    }

    try {
      save(record);
      added++;
      console.log(styleText("green", `[+] ${verb} ${item.display}`));
    } catch (err) {
      failed.push({ path: item.path, error: err.message });
      console.log(styleText("red", `[-] Failed ${item.display}`));
    }
  }

  return added;
}

// Extras that can't be recorded because their album (or the batch) has nothing in the database yet
function failItems(files, sourceDir, reason, failed) {
  for (const file of files) {
    failed.push({ path: file, error: reason });
    console.log(styleText("red", `[-] Failed ${toRel(sourceDir, file)}`));
  }
}

async function askBatchLabel(defaultLabel) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(`Batch label [${defaultLabel}]: `);
    return answer.trim() || defaultLabel;
  } finally {
    rl.close();
  }
}

async function main() {
  const banner = `
┌┬┐┬─┐┌─┐┌─┐┬┌─┌┬┐┌─┐┌┬┐┌┐
 │ ├┬┘├─┤│  ├┴┐ │ │ ││││├┴┐
 ┴ ┴└─┴ ┴└─┘┴ ┴ ┴ └─┘┴ ┴└─┘
`;
  console.log(banner.trimStart());

  const sourceDir = process.cwd();

  // check if metaflac is available
  const checkMetaflac = spawnSync("metaflac", ["--version"]);

  if (checkMetaflac.error) {
    const errorMsg =
      checkMetaflac.error.code === "ENOENT"
        ? "Cannot run metaflac: Make sure it is available in your PATH."
        : `Cannot run metaflac: ${checkMetaflac.error.message}`;

    throw new Error(errorMsg);
  }

  if (checkMetaflac.status !== 0)
    throw new Error(
      `metaflac version check failed with exit code ${checkMetaflac.status}`,
    );

  // scan current directory for files
  const { files, skipped } = scanDir(sourceDir);

  const filesByExtension = {};

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();

    if (!filesByExtension[ext]) filesByExtension[ext] = [];
    filesByExtension[ext].push(file);
  }

  const flacs = (filesByExtension[".flac"] ?? []).sort();
  const extras = files
    .filter((f) => path.extname(f).toLowerCase() !== ".flac")
    .sort();

  if (flacs.length === 0) {
    const reason =
      skipped.length > 0
        ? `No flac files found, and ${skipped.length} directories could not be read (first: ${skipped[0].path}, ${skipped[0].error})`
        : `Current directory does not contain any flac files: ${sourceDir}`;

    throw new Error(reason);
  }

  // group flacs into albums, then hang every other file on its nearest album folder
  const groups = new Map();

  for (const file of flacs) {
    const dir = albumDirOf(file, sourceDir);

    if (!groups.has(dir))
      groups.set(dir, {
        dir,
        rel: toRel(sourceDir, dir) || ".", // relative to the batch folder, never includes the batch folder itself
        id: null, // album row id, once it exists
        values: null, // album tags as currently stored
        warned: new Set(),
        flacs: [],
        extras: [],
      });

    groups.get(dir).flacs.push(file);
  }

  const orphans = []; // extras outside every album folder

  for (const file of extras) {
    const group = findAlbum(file, sourceDir, groups);
    if (group) group.extras.push(file);
    else orphans.push(file);
  }

  const albums = [...groups.values()].sort((a, b) =>
    a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0,
  );

  let extLog = "";

  for (const ext in filesByExtension)
    extLog += `    ${ext !== "" ? ext : " no ext"}: ${filesByExtension[ext].length}\n`;

  // summary
  console.log(`Source Directory     : ${sourceDir}`);
  console.log(`Files found          : ${files.length}`);
  console.log(extLog.trimEnd());
  console.log(`Albums found         : ${albums.length}`);
  if (skipped.length > 0) {
    console.log(`Directories skipped  : ${skipped.length}\n`);
    skipped.forEach((s, i) =>
      console.log(`    ${i + 1}. ${s.path} (${s.error})`),
    );
  }
  console.log();

  // open the database (it is created on the first run) and find the batch
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.exec(SCHEMA);

  const label = await askBatchLabel(
    path.basename(sourceDir) || path.parse(sourceDir).root,
  );

  const existingBatch = db
    .prepare("SELECT id FROM batches WHERE label = ?")
    .get(label);

  console.log(
    `Batch                : ${label} (${existingBatch ? "existing, adding new files" : "new"})`,
  );
  console.log(`Database             : ${DB_PATH}\n`);

  const failed = [];
  const totals = {
    albumsCreated: 0,
    conflicts: 0,
    tracksAdded: 0,
    tracksRecorded: 0,
    extrasAdded: 0,
    extrasRecorded: 0,
  };

  // the batch row is only created together with the first track that gets recorded
  let batchId = existingBatch?.id ?? null;

  // albums this batch already has
  if (batchId) {
    const findAlbumRow = db.prepare(
      "SELECT * FROM albums WHERE batch_id = ? AND rel_path = ?",
    );

    for (const group of albums) {
      const row = findAlbumRow.get(batchId, group.rel);

      if (row) {
        group.id = row.id;
        group.values = row;
      }
    }
  }

  const insertBatch = db.prepare(
    "INSERT INTO batches (label, created_at) VALUES (?, ?)",
  );
  const insertAlbum = db.prepare(INSERT_ALBUM);
  const insertTrack = db.prepare(INSERT_TRACK);
  const insertExtra = db.prepare(INSERT_EXTRA);

  const updateAlbum = Object.fromEntries(
    ALBUM_TAGS.map((tag) => [
      tag,
      db.prepare(`UPDATE albums SET ${tag} = ? WHERE id = ?`),
    ]),
  );

  const isTrackRecorded = db.prepare(
    "SELECT 1 FROM tracks WHERE album_id = ? AND rel_path = ? AND size = ? AND mtime_ms = ?",
  );

  const isExtraRecorded = db.prepare(
    "SELECT 1 FROM extras WHERE batch_id = ? AND album_id IS ? AND rel_path = ? AND size = ? AND mtime_ms = ?",
  );

  // one transaction per track: the batch row, the album row (created, or its empty tags filled in) and the track row are saved together or not at all
  function saveTrack(group, record) {
    db.exec("BEGIN");
    try {
      const now = new Date().toISOString();
      const bId = batchId ?? insertBatch.run(label, now).lastInsertRowid;

      const created = group.id === null;
      const fills = {};
      const conflicts = [];
      let albumId = group.id;

      if (created) {
        albumId = insertAlbum.run({
          batch_id: bId,
          rel_path: group.rel,
          ...record.album,
          created_at: now,
        }).lastInsertRowid;
      } else {
        for (const tag of ALBUM_TAGS) {
          const value = record.album[tag];
          if (value === null) continue;

          if (group.values[tag] === null) {
            updateAlbum[tag].run(value, albumId);
            fills[tag] = value;
          } else if (String(group.values[tag]) !== String(value)) {
            conflicts.push(tag);
          }
        }
      }

      insertTrack.run({ album_id: albumId, ...record.track, scanned_at: now });

      db.exec("COMMIT");
      return { bId, albumId, created, fills, conflicts };
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // ignore if no active transaction
      }
      throw err;
    }
  }

  // album by album: its tracks first, then its extras
  for (const group of albums) {
    const trackPlan = planFiles(
      group.flacs,
      group.dir,
      sourceDir,
      group.id
        ? (i) => !!isTrackRecorded.get(group.id, i.rel, i.size, i.mtimeMs)
        : () => false,
      failed,
    );

    totals.tracksRecorded += trackPlan.recorded;

    totals.tracksAdded += runItems({
      todo: trackPlan.todo,
      build: catalogFile,
      verb: "Scanned",
      failed,
      save: (record) => {
        // the in-memory state only changes after the transaction has committed
        const result = saveTrack(group, record);

        batchId = result.bId;

        if (result.created) {
          group.id = result.albumId;
          group.values = { ...record.album };
          totals.albumsCreated++;
        } else {
          Object.assign(group.values, result.fills);
        }

        // tracks of one album disagreeing about an album tag: the first value is kept (every track still has its own raw_tags)
        for (const tag of result.conflicts) {
          if (group.warned.has(tag)) continue;

          group.warned.add(tag);
          totals.conflicts++;

          console.log(
            styleText(
              "yellow",
              `[!] ${group.rel}: ${tag} differs between tracks (kept ${JSON.stringify(group.values[tag])}, this track has ${JSON.stringify(record.album[tag])})`,
            ),
          );
        }
      },
    });

    if (group.extras.length === 0) continue;

    if (group.id === null) {
      failItems(
        group.extras,
        sourceDir,
        "Album has no cataloged tracks, so the extra was not inventoried",
        failed,
      );
      continue;
    }

    const extraPlan = planFiles(
      group.extras,
      group.dir,
      sourceDir,
      (i) => !!isExtraRecorded.get(batchId, group.id, i.rel, i.size, i.mtimeMs),
      failed,
    );

    totals.extrasRecorded += extraPlan.recorded;

    totals.extrasAdded += runItems({
      todo: extraPlan.todo,
      build: inventoryExtra,
      verb: "Inventoried",
      failed,
      save: (record) =>
        insertExtra.run({
          batch_id: batchId,
          album_id: group.id,
          ...record,
          scanned_at: new Date().toISOString(),
        }),
    });
  }

  // extras outside every album folder: album_id stays NULL and rel_path is relative to the batch folder
  if (orphans.length > 0) {
    if (batchId === null) {
      failItems(
        orphans,
        sourceDir,
        "No tracks were cataloged, so the extra was not inventoried",
        failed,
      );
    } else {
      const orphanPlan = planFiles(
        orphans,
        sourceDir,
        sourceDir,
        (i) => !!isExtraRecorded.get(batchId, null, i.rel, i.size, i.mtimeMs),
        failed,
      );

      totals.extrasRecorded += orphanPlan.recorded;

      totals.extrasAdded += runItems({
        todo: orphanPlan.todo,
        build: inventoryExtra,
        verb: "Inventoried",
        failed,
        save: (record) =>
          insertExtra.run({
            batch_id: batchId,
            album_id: null,
            ...record,
            scanned_at: new Date().toISOString(),
          }),
      });
    }
  }

  db.close();

  return {
    label,
    skippedDirectories: skipped,
    totalAlbums: albums.length,
    totalFlacs: flacs.length,
    totalExtras: extras.length,
    totals,
    failed,
  };
}

main()
  .then(
    ({
      label,
      skippedDirectories,
      totalAlbums,
      totalFlacs,
      totalExtras,
      totals,
      failed,
    }) => {
      if (skippedDirectories.length > 0) process.exitCode = 2;

      const color =
        failed.length > 0
          ? "red"
          : skippedDirectories.length > 0
            ? "yellow"
            : "green";

      const skippedPart =
        skippedDirectories.length > 0
          ? `Skipped Directories: ${skippedDirectories.length} | `
          : "";

      console.log(
        styleText(
          color,
          `\nCompleted in ${((performance.now() - timer) / 1000).toFixed(2)}s! ${skippedPart}Batch: ${label} | Failed: ${failed.length}`,
        ),
      );

      console.log(
        styleText(
          color,
          `Albums | Found: ${totalAlbums} | New: ${totals.albumsCreated}`,
        ),
      );

      console.log(
        styleText(
          color,
          `Flacs  | Checked: ${totalFlacs} | Added: ${totals.tracksAdded} | Already recorded: ${totals.tracksRecorded}`,
        ),
      );

      console.log(
        styleText(
          color,
          `Extras | Checked: ${totalExtras} | Added: ${totals.extrasAdded} | Already recorded: ${totals.extrasRecorded}`,
        ),
      );

      if (totals.conflicts > 0)
        console.log(
          styleText(
            "yellow",
            `\n[!] ${totals.conflicts} album tag(s) differ between tracks of the same album (first value kept, see warnings above)`,
          ),
        );

      if (skippedDirectories.length > 0)
        console.log(
          styleText(
            "yellow",
            `\n[!] ${skippedDirectories.length} unreadable director${skippedDirectories.length === 1 ? "y" : "ies"} are NOT in the catalog`,
          ),
        );

      if (failed.length > 0) {
        console.log(
          styleText("red", "\n--- Files that could not be cataloged ---"),
        );

        failed.forEach((f, i) => {
          console.log(styleText("red", `\n[${i + 1}] ${f.path}`));
          console.log(f.error);
        });

        process.exitCode = 1;
      }
    },
  )
  .catch((err) => {
    console.error(err.message);
    if (err.cause) console.error("Caused by:", err.cause.message ?? err.cause);
    process.exit(1);
  });
