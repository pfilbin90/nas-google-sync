import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { loadConfig } from '../config.js';
import { logger } from '../utils/logger.js';

const config = loadConfig();

export interface PhotoRecord {
  id: string;
  source: 'google' | 'synology';
  accountName: string;
  filename: string;
  mimeType: string;
  creationTime: string;
  width?: number;
  height?: number;
  fileSize?: number;
  hash?: string;
  googleMediaItemId?: string;
  synologyPath?: string;
  isBackedUp: boolean;
  backedUpAt?: string;
  canBeRemoved: boolean;
  lastScannedAt: string;
  albumName?: string;  // Album/folder name from Google Takeout
}

export interface StorageStats {
  source: string;
  accountName: string;
  usedBytes: number;
  totalBytes: number;
  percentUsed: number;
  lastCheckedAt: string;
}

let db: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (db) return db;

  const dbDir = path.dirname(config.databasePath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(config.databasePath);
  initializeSchema(db);
  return db;
}

function initializeSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS photos (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      account_name TEXT NOT NULL,
      filename TEXT NOT NULL,
      mime_type TEXT,
      creation_time TEXT,
      width INTEGER,
      height INTEGER,
      file_size INTEGER,
      hash TEXT,
      google_media_item_id TEXT,
      synology_path TEXT,
      is_backed_up INTEGER DEFAULT 0,
      backed_up_at TEXT,
      can_be_removed INTEGER DEFAULT 0,
      last_scanned_at TEXT NOT NULL,
      album_name TEXT,
      UNIQUE(source, account_name, google_media_item_id),
      UNIQUE(source, synology_path)
    );

    CREATE TABLE IF NOT EXISTS storage_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      account_name TEXT NOT NULL,
      used_bytes INTEGER,
      total_bytes INTEGER,
      percent_used REAL,
      last_checked_at TEXT NOT NULL,
      UNIQUE(source, account_name)
    );

    CREATE TABLE IF NOT EXISTS duplicates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      photo_id_1 TEXT NOT NULL,
      photo_id_2 TEXT NOT NULL,
      confidence REAL,
      detected_at TEXT NOT NULL,
      FOREIGN KEY (photo_id_1) REFERENCES photos(id),
      FOREIGN KEY (photo_id_2) REFERENCES photos(id),
      UNIQUE(photo_id_1, photo_id_2)
    );

    CREATE INDEX IF NOT EXISTS idx_photos_hash ON photos(hash);
    CREATE INDEX IF NOT EXISTS idx_photos_creation_time ON photos(creation_time);
    CREATE INDEX IF NOT EXISTS idx_photos_source_account ON photos(source, account_name);
    CREATE INDEX IF NOT EXISTS idx_photos_filename ON photos(filename);
    CREATE INDEX IF NOT EXISTS idx_photos_album_name ON photos(album_name);
  `);

  // Add album_name column if it doesn't exist (for existing databases)
  try {
    database.exec(`ALTER TABLE photos ADD COLUMN album_name TEXT`);
    logger.info('Added album_name column to photos table');
  } catch (e: any) {
    // Ignore "duplicate column name" errors, but re-throw others
    if (!e.message?.includes('duplicate column name')) {
      throw e;
    }
  }

  logger.info('Database schema initialized');
}

export function insertPhoto(photo: PhotoRecord): void {
  const database = getDatabase();
  const stmt = database.prepare(`
    INSERT OR REPLACE INTO photos (
      id, source, account_name, filename, mime_type, creation_time,
      width, height, file_size, hash, google_media_item_id, synology_path,
      is_backed_up, backed_up_at, can_be_removed, last_scanned_at, album_name
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `);

  stmt.run(
    photo.id,
    photo.source,
    photo.accountName,
    photo.filename,
    photo.mimeType,
    photo.creationTime,
    photo.width,
    photo.height,
    photo.fileSize,
    photo.hash,
    photo.googleMediaItemId,
    photo.synologyPath,
    photo.isBackedUp ? 1 : 0,
    photo.backedUpAt,
    photo.canBeRemoved ? 1 : 0,
    photo.lastScannedAt,
    photo.albumName
  );
}

export function getPhotosBySource(source: 'google' | 'synology', accountName?: string): PhotoRecord[] {
  const database = getDatabase();
  let query = 'SELECT * FROM photos WHERE source = ?';
  const params: string[] = [source];

  if (accountName) {
    query += ' AND account_name = ?';
    params.push(accountName);
  }

  const rows = database.prepare(query).all(...params) as any[];
  return rows.map(mapRowToPhoto);
}

export function findDuplicates(): Array<{ photo1: PhotoRecord; photo2: PhotoRecord; matchType: string }> {
  const database = getDatabase();

  // Find duplicates by hash
  const hashDuplicates = database.prepare(`
    SELECT p1.*, p2.id as p2_id, p2.source as p2_source, p2.account_name as p2_account_name,
           p2.filename as p2_filename, p2.synology_path as p2_synology_path
    FROM photos p1
    JOIN photos p2 ON p1.hash = p2.hash AND p1.id < p2.id
    WHERE p1.hash IS NOT NULL AND p1.hash != ''
  `).all() as any[];

  // Find duplicates by filename + creation_time
  const nameDateDuplicates = database.prepare(`
    SELECT p1.*, p2.id as p2_id, p2.source as p2_source, p2.account_name as p2_account_name,
           p2.filename as p2_filename, p2.synology_path as p2_synology_path
    FROM photos p1
    JOIN photos p2 ON p1.filename = p2.filename
      AND p1.creation_time = p2.creation_time
      AND p1.id < p2.id
    WHERE p1.creation_time IS NOT NULL
  `).all() as any[];

  const results: Array<{ photo1: PhotoRecord; photo2: PhotoRecord; matchType: string }> = [];

  for (const row of hashDuplicates) {
    results.push({
      photo1: mapRowToPhoto(row),
      photo2: {
        id: row.p2_id,
        source: row.p2_source,
        accountName: row.p2_account_name,
        filename: row.p2_filename,
        synologyPath: row.p2_synology_path,
      } as PhotoRecord,
      matchType: 'hash',
    });
  }

  for (const row of nameDateDuplicates) {
    const exists = results.some(
      r => (r.photo1.id === row.id && r.photo2.id === row.p2_id) ||
           (r.photo1.id === row.p2_id && r.photo2.id === row.id)
    );
    if (!exists) {
      results.push({
        photo1: mapRowToPhoto(row),
        photo2: {
          id: row.p2_id,
          source: row.p2_source,
          accountName: row.p2_account_name,
          filename: row.p2_filename,
          synologyPath: row.p2_synology_path,
        } as PhotoRecord,
        matchType: 'filename+date',
      });
    }
  }

  return results;
}

export function getPhotosBackedUpToSynology(): PhotoRecord[] {
  const database = getDatabase();
  const rows = database.prepare(`
    SELECT * FROM photos
    WHERE source = 'google' AND is_backed_up = 1
  `).all() as any[];
  return rows.map(mapRowToPhoto);
}

export function getPhotosNotBackedUp(accountName?: string): PhotoRecord[] {
  const database = getDatabase();
  let query = `SELECT * FROM photos WHERE source = 'google' AND is_backed_up = 0`;
  const params: string[] = [];

  if (accountName) {
    query += ' AND account_name = ?';
    params.push(accountName);
  }

  query += ' ORDER BY creation_time ASC';

  const rows = database.prepare(query).all(...params) as any[];
  return rows.map(mapRowToPhoto);
}

export function markAsBackedUp(photoId: string): void {
  const database = getDatabase();
  database.prepare(`
    UPDATE photos
    SET is_backed_up = 1, backed_up_at = ?, can_be_removed = 1
    WHERE id = ?
  `).run(new Date().toISOString(), photoId);
}

export function updateStorageStats(stats: StorageStats): void {
  const database = getDatabase();
  database.prepare(`
    INSERT OR REPLACE INTO storage_stats (source, account_name, used_bytes, total_bytes, percent_used, last_checked_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(stats.source, stats.accountName, stats.usedBytes, stats.totalBytes, stats.percentUsed, stats.lastCheckedAt);
}

export function getStorageStats(): StorageStats[] {
  const database = getDatabase();
  const rows = database.prepare('SELECT * FROM storage_stats').all() as any[];
  return rows.map(row => ({
    source: row.source,
    accountName: row.account_name,
    usedBytes: row.used_bytes,
    totalBytes: row.total_bytes,
    percentUsed: row.percent_used,
    lastCheckedAt: row.last_checked_at,
  }));
}

export function getPhotoStats(): {
  totalGoogle: number;
  totalSynology: number;
  backedUp: number;
  canBeRemoved: number;
  duplicates: number;
} {
  const database = getDatabase();

  const googleCount = database.prepare(`SELECT COUNT(*) as count FROM photos WHERE source = 'google'`).get() as any;
  const synologyCount = database.prepare(`SELECT COUNT(*) as count FROM photos WHERE source = 'synology'`).get() as any;
  const backedUpCount = database.prepare(`SELECT COUNT(*) as count FROM photos WHERE is_backed_up = 1`).get() as any;
  const canRemoveCount = database.prepare(`SELECT COUNT(*) as count FROM photos WHERE can_be_removed = 1`).get() as any;
  const duplicatesCount = database.prepare(`SELECT COUNT(*) as count FROM duplicates`).get() as any;

  return {
    totalGoogle: googleCount?.count || 0,
    totalSynology: synologyCount?.count || 0,
    backedUp: backedUpCount?.count || 0,
    canBeRemoved: canRemoveCount?.count || 0,
    duplicates: duplicatesCount?.count || 0,
  };
}

function mapRowToPhoto(row: any): PhotoRecord {
  return {
    id: row.id,
    source: row.source,
    accountName: row.account_name,
    filename: row.filename,
    mimeType: row.mime_type,
    creationTime: row.creation_time,
    width: row.width,
    height: row.height,
    fileSize: row.file_size,
    hash: row.hash,
    googleMediaItemId: row.google_media_item_id,
    synologyPath: row.synology_path,
    isBackedUp: row.is_backed_up === 1,
    backedUpAt: row.backed_up_at,
    canBeRemoved: row.can_be_removed === 1,
    lastScannedAt: row.last_scanned_at,
    albumName: row.album_name,
  };
}

/**
 * Get unique album names from imported photos
 */
export function getAlbumStats(accountName?: string): Map<string, number> {
  const database = getDatabase();
  let query = `
    SELECT album_name, COUNT(*) as count FROM photos
    WHERE source = 'google' AND album_name IS NOT NULL AND album_name != ''
  `;
  const params: string[] = [];

  if (accountName) {
    query += ' AND account_name = ?';
    params.push(accountName);
  }

  query += ' GROUP BY album_name ORDER BY count DESC';

  const rows = database.prepare(query).all(...params) as Array<{ album_name: string; count: number }>;
  const albumStats = new Map<string, number>();

  for (const row of rows) {
    albumStats.set(row.album_name, row.count);
  }

  return albumStats;
}

/**
 * Get photos by album name
 */
export function getPhotosByAlbum(albumName: string, accountName?: string): PhotoRecord[] {
  const database = getDatabase();
  let query = `SELECT * FROM photos WHERE source = 'google' AND album_name = ?`;
  const params: string[] = [albumName];

  if (accountName) {
    query += ' AND account_name = ?';
    params.push(accountName);
  }

  query += ' ORDER BY creation_time ASC';

  const rows = database.prepare(query).all(...params) as any[];
  return rows.map(mapRowToPhoto);
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
