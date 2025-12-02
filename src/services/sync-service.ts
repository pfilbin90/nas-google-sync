import fs from 'fs';
import path from 'path';
import { loadConfig, getPairedSynologyAccount } from '../config.js';
import { logger } from '../utils/logger.js';
import { SynologyPhotosService } from './synology-photos.js';
import { GoogleTakeoutService, TakeoutPhoto, TakeoutScanResult } from './google-takeout.js';
import { TagWriterService } from './tag-writer.js';
import {
  getPhotoStats,
  findDuplicates,
  getPhotosNotBackedUp,
  markAsBackedUp,
  getStorageStats,
  PhotoRecord,
  getPhotosBySource,
  getDatabase,
  getOrCreateAlbum,
  addPhotoToAlbum,
  updatePhotoSynologyId,
  getPhotosNeedingAlbumSync,
  getPhotosNeedingSynologyId,
  getAlbumSyncStats,
} from '../models/database.js';

const config = loadConfig();

export interface AnalysisReport {
  timestamp: string;
  googleAccounts: Array<{
    name: string;
    totalPhotos: number;
    photosBackedUp: number;
    photosNotBackedUp: number;
    canBeRemoved: number;
    pairedWith: string | null;
  }>;
  synologyAccounts: Array<{
    name: string;
    totalPhotos: number;
    storageUsed: number;
    storageTotal: number;
    percentUsed: number;
  }>;
  duplicates: Array<{
    photo1: { source: string; account: string; filename: string; hash: string };
    photo2: { source: string; account: string; filename: string; hash: string };
    matchType: string;
  }>;
  recommendations: string[];
}

export interface ImportResult {
  accountName: string;
  totalScanned: number;
  newPhotos: number;
  duplicatesInSynology: number;
  duplicatesInTakeout: number;
  errors: string[];
  albumsFound: Map<string, number>;  // Album name -> photo count
}

export interface SyncOptions {
  limit?: number;
  dryRun?: boolean;
  organizeByAlbum?: boolean;  // Create album folders on Synology
  tagWithAlbum?: boolean;     // Write album name to photo EXIF tags
  reprocess?: boolean;        // Re-apply album tags to already-synced photos
}

export interface FixAlbumsOptions {
  limit?: number;
  batchSize?: number;
  dryRun?: boolean;
}

export interface FixAlbumsResult {
  processed: number;
  addedToAlbums: number;
  albumsCreated: number;
  photoIdsFound: number;
  errors: number;
  skipped: number;
}

export class SyncService {
  private synologyServices: Map<string, SynologyPhotosService> = new Map();

  constructor() {
    for (const account of config.synologyAccounts) {
      this.synologyServices.set(account.name, new SynologyPhotosService(account));
    }
  }

  async authenticateAll(): Promise<void> {
    logger.info('Authenticating Synology services...');

    for (const [name, service] of this.synologyServices) {
      try {
        await service.authenticate();
        logger.info(`Synology account ${name} authenticated`);
      } catch (error) {
        logger.error(`Failed to authenticate Synology account ${name}: ${error}`);
      }
    }
  }

  async authenticateSynology(accountName: string): Promise<SynologyPhotosService | null> {
    const service = this.synologyServices.get(accountName);
    if (!service) {
      logger.error(`Unknown Synology account: ${accountName}`);
      return null;
    }

    try {
      await service.authenticate();
      return service;
    } catch (error) {
      logger.error(`Failed to authenticate Synology account ${accountName}: ${error}`);
      return null;
    }
  }

  async scanSynology(onProgress?: (source: string, count: number) => void): Promise<void> {
    logger.info('Scanning Synology sources...');

    for (const [name, service] of this.synologyServices) {
      try {
        await service.scanAllPhotos((count) => {
          if (onProgress) onProgress(`Synology: ${name}`, count);
        });
      } catch (error) {
        logger.error(`Failed to scan Synology account ${name}: ${error}`);
      }
    }

    logger.info('Synology scan complete');
  }

  /**
   * Import photos from a Google Takeout export folder
   */
  async importFromTakeout(
    takeoutPath: string,
    accountName: string,
    onProgress?: (count: number) => void
  ): Promise<ImportResult> {
    logger.info(`Importing Google Takeout for ${accountName} from: ${takeoutPath}`);

    const result: ImportResult = {
      accountName,
      totalScanned: 0,
      newPhotos: 0,
      duplicatesInSynology: 0,
      duplicatesInTakeout: 0,
      errors: [],
      albumsFound: new Map(),
    };

    // Scan the takeout folder
    const takeoutService = new GoogleTakeoutService(accountName);
    const scanResult = await takeoutService.scanTakeoutFolder(takeoutPath, onProgress);

    result.totalScanned = scanResult.photos.length;
    result.errors = scanResult.errors;
    result.albumsFound = scanResult.albumsFound;

    // Get existing Synology photos for comparison (by hash and by filename+date)
    const synologyByHash = this.getAllSynologyPhotoHashes();
    const synologyByFilenameDate = this.getAllSynologyPhotosByFilenameDate();

    // Track what we've already seen in this takeout
    const seenTakeoutHashes = new Set<string>();
    const seenTakeoutFilenameDate = new Set<string>();

    // Check each photo for duplicates
    const newPhotos: TakeoutPhoto[] = [];
    const alreadyBackedUp: TakeoutPhoto[] = [];

    for (const photo of scanResult.photos) {
      // Create a filename+date key for matching (normalize date to just the date part)
      const dateKey = this.normalizeDate(photo.creationTime);
      const filenameDateKey = `${photo.filename.toLowerCase()}|${dateKey}`;

      // Check if it's a duplicate (by hash OR by filename+date)
      const hashMatch = synologyByHash.has(photo.hash);
      const filenameDateMatch = synologyByFilenameDate.has(filenameDateKey);

      if (hashMatch || filenameDateMatch) {
        result.duplicatesInSynology++;
        alreadyBackedUp.push(photo);
        logger.debug(`Duplicate found: ${photo.filename} (${hashMatch ? 'hash' : 'filename+date'} match)`);
      } else if (seenTakeoutHashes.has(photo.hash) || seenTakeoutFilenameDate.has(filenameDateKey)) {
        result.duplicatesInTakeout++;
      } else {
        newPhotos.push(photo);
        seenTakeoutHashes.add(photo.hash);
        seenTakeoutFilenameDate.add(filenameDateKey);
      }
    }

    result.newPhotos = newPhotos.length;

    // Import new photos to database (need to be synced)
    await takeoutService.importToDatabase(newPhotos);

    // Also import already-backed-up photos so they show in export (marked as backed up)
    await takeoutService.importAsBackedUp(alreadyBackedUp);

    logger.info(
      `Takeout import complete for ${accountName}: ` +
      `${result.totalScanned} scanned, ${result.newPhotos} new, ` +
      `${result.duplicatesInSynology} already on Synology, ` +
      `${result.duplicatesInTakeout} duplicates in takeout`
    );

    return result;
  }

  private getAllSynologyPhotoHashes(): Set<string> {
    const db = getDatabase();
    const rows = db.prepare(`
      SELECT hash FROM photos
      WHERE source = 'synology' AND hash IS NOT NULL AND hash != ''
    `).all() as Array<{ hash: string }>;

    return new Set(rows.map(r => r.hash));
  }

  private getAllSynologyPhotosByFilenameDate(): Set<string> {
    const db = getDatabase();
    const rows = db.prepare(`
      SELECT filename, creation_time FROM photos
      WHERE source = 'synology' AND filename IS NOT NULL AND creation_time IS NOT NULL
    `).all() as Array<{ filename: string; creation_time: string }>;

    return new Set(rows.map(r => {
      const dateKey = this.normalizeDate(r.creation_time);
      return `${r.filename.toLowerCase()}|${dateKey}`;
    }));
  }

  /**
   * Normalize a date to YYYY-MM-DD format for comparison
   * This allows matching photos taken on the same day even if times differ slightly
   */
  private normalizeDate(dateStr: string): string {
    try {
      const date = new Date(dateStr);
      return date.toISOString().split('T')[0]; // Returns YYYY-MM-DD
    } catch {
      return dateStr;
    }
  }

  /**
   * Sync photos from takeout to Synology
   */
  async syncToSynology(
    accountName: string,
    options: SyncOptions = {},
    onProgress?: (current: number, total: number, filename: string) => void
  ): Promise<{ synced: number; failed: number; skipped: number; tagged: number }> {
    const { limit, dryRun = config.dryRun, organizeByAlbum = false, tagWithAlbum = true } = options;

    // Find the paired Synology account
    const pairedSynology = getPairedSynologyAccount(config, accountName);
    if (!pairedSynology) {
      throw new Error(
        `No Synology account paired with "${accountName}". ` +
        `Configure PAIRING_*_GOOGLE and PAIRING_*_SYNOLOGY in .env`
      );
    }

    const synologyService = this.synologyServices.get(pairedSynology.name);
    if (!synologyService) {
      throw new Error(`Synology service not found for account: ${pairedSynology.name}`);
    }

    // Get photos that need to be synced (from takeout, not yet backed up)
    const allPhotosToSync = getPhotosNotBackedUp(accountName);
    const photosToSync = limit ? allPhotosToSync.slice(0, limit) : allPhotosToSync;

    const modeInfo = [];
    if (organizeByAlbum) modeInfo.push('organize by album');
    if (tagWithAlbum) modeInfo.push('tag with album');
    const modeStr = modeInfo.length > 0 ? ` (${modeInfo.join(', ')})` : '';

    logger.info(
      `${dryRun ? '[DRY RUN] ' : ''}Syncing ${photosToSync.length} photos from ${accountName} ` +
      `to ${pairedSynology.name}'s Synology Photos${modeStr}...`
    );

    let synced = 0;
    let failed = 0;
    let skipped = 0;
    let tagged = 0;

    // Track created folders to avoid redundant API calls
    const createdFolders = new Set<string>();

    // Initialize tag writer if needed (only in non-dry-run mode)
    let tagWriter: TagWriterService | null = null;
    if (tagWithAlbum && !dryRun) {
      tagWriter = new TagWriterService(dryRun);
    }

    // Get database connection and prepare statement outside the loop for performance
    const db = getDatabase();
    const photoStmt = db.prepare(`
      SELECT synology_path, album_name FROM photos WHERE id = ?
    `);

    try {
      for (let i = 0; i < photosToSync.length; i++) {
        const photo = photosToSync[i];

        if (onProgress) {
          onProgress(i + 1, photosToSync.length, photo.filename);
        }

        // Get the file path and album name from database
        const row = photoStmt.get(photo.id) as { synology_path?: string; album_name?: string } | undefined;

        const filePath = row?.synology_path;
        const albumName = row?.album_name;

        if (!filePath || !fs.existsSync(filePath)) {
          logger.warn(`File not found for ${photo.filename}, skipping...`);
          skipped++;
          continue;
        }

        try {
          // Determine destination folder
          let destFolder = pairedSynology.photoLibraryPath;
          if (organizeByAlbum && albumName) {
            // Sanitize album name to be a valid folder name
            const sanitizedAlbumName = this.sanitizeAlbumName(albumName);
            destFolder = path.join(pairedSynology.photoLibraryPath, sanitizedAlbumName);

            // Create folder if not already created (Synology will auto-create, but we track it)
            if (!createdFolders.has(sanitizedAlbumName)) {
              if (!dryRun) {
                logger.debug(`Photos will be organized into album folder: ${sanitizedAlbumName}`);
              }
              createdFolders.add(sanitizedAlbumName);
            }
          }

          if (dryRun) {
            const albumInfo = albumName ? ` [Album: ${albumName}]` : '';
            logger.info(`[DRY RUN] Would sync: ${photo.filename} to ${destFolder}${albumInfo}`);
            synced++;
          } else {
            logger.info(`Uploading: ${photo.filename}${albumName ? ` [${albumName}]` : ''}`);
            const buffer = fs.readFileSync(filePath);
            const success = await synologyService.uploadPhoto(buffer, photo.filename, destFolder);

            if (success) {
              // Write album tag to photo after successful upload
              if (tagWithAlbum && tagWriter && albumName) {
                const tagResult = await tagWriter.writeAlbumTag(filePath, albumName);
                if (tagResult.success) {
                  tagged++;
                }
              }

              markAsBackedUp(photo.id);
              synced++;
              logger.info(`Synced: ${photo.filename}`);
            } else {
              failed++;
              logger.error(`Failed to upload: ${photo.filename}`);
            }
          }

          // Rate limiting
          await this.delay(200);
        } catch (error) {
          failed++;
          logger.error(`Error syncing ${photo.filename}: ${error}`);
        }
      }
    } finally {
      // Clean up tag writer
      if (tagWriter) {
        await tagWriter.close();
      }
    }

    logger.info(`Sync complete: ${synced} synced, ${failed} failed, ${skipped} skipped, ${tagged} tagged`);
    return { synced, failed, skipped, tagged };
  }

  async checkStorageQuotas(): Promise<Map<string, { used: number; total: number; percentUsed: number }>> {
    const quotas = new Map<string, { used: number; total: number; percentUsed: number }>();

    for (const [name, service] of this.synologyServices) {
      try {
        const quota = await service.getStorageInfo();
        quotas.set(`synology:${name}`, quota);
      } catch (error) {
        logger.error(`Failed to get Synology storage info for ${name}: ${error}`);
      }
    }

    return quotas;
  }

  async generateAnalysisReport(): Promise<AnalysisReport> {
    logger.info('Generating analysis report...');

    const duplicates = findDuplicates();
    const storageStats = getStorageStats();

    const report: AnalysisReport = {
      timestamp: new Date().toISOString(),
      googleAccounts: [],
      synologyAccounts: [],
      duplicates: [],
      recommendations: [],
    };

    // Process Google/Takeout account stats
    for (const account of config.googleAccounts) {
      const googlePhotos = getPhotosBySource('google', account.name);
      const backedUp = googlePhotos.filter(p => p.isBackedUp).length;
      const canRemove = googlePhotos.filter(p => p.canBeRemoved).length;

      const pairedSynology = getPairedSynologyAccount(config, account.name);

      report.googleAccounts.push({
        name: account.name,
        totalPhotos: googlePhotos.length,
        photosBackedUp: backedUp,
        photosNotBackedUp: googlePhotos.length - backedUp,
        canBeRemoved: canRemove,
        pairedWith: pairedSynology?.name || null,
      });
    }

    // Process Synology account stats
    for (const account of config.synologyAccounts) {
      const synologyPhotos = getPhotosBySource('synology', account.name);
      const accountStorage = storageStats.find(
        s => s.source === 'synology' && s.accountName === account.name
      );

      report.synologyAccounts.push({
        name: account.name,
        totalPhotos: synologyPhotos.length,
        storageUsed: accountStorage?.usedBytes || 0,
        storageTotal: accountStorage?.totalBytes || 0,
        percentUsed: accountStorage?.percentUsed || 0,
      });
    }

    // Process duplicates
    report.duplicates = duplicates.map(d => ({
      photo1: {
        source: d.photo1.source,
        account: d.photo1.accountName,
        filename: d.photo1.filename,
        hash: d.photo1.hash || '',
      },
      photo2: {
        source: d.photo2.source,
        account: d.photo2.accountName,
        filename: d.photo2.filename,
        hash: d.photo2.hash || '',
      },
      matchType: d.matchType,
    }));

    // Generate recommendations
    report.recommendations = this.generateRecommendations(report);

    return report;
  }

  private generateRecommendations(report: AnalysisReport): string[] {
    const recommendations: string[] = [];

    for (const account of report.googleAccounts) {
      if (account.photosNotBackedUp > 0) {
        recommendations.push(
          `${account.name} has ${account.photosNotBackedUp} photos from Google Takeout not yet synced to Synology. ` +
          `Run 'npm run sync -- --account ${account.name}' to sync them.`
        );
      }

      if (account.canBeRemoved > 0) {
        recommendations.push(
          `${account.canBeRemoved} photos from ${account.name}'s Google Takeout are safely backed up to Synology ` +
          `and can be deleted from Google Photos to free up space.`
        );
      }

      if (!account.pairedWith) {
        recommendations.push(
          `WARNING: ${account.name} is not paired with a Synology account. ` +
          `Configure PAIRING_*_GOOGLE and PAIRING_*_SYNOLOGY in .env to enable syncing.`
        );
      }
    }

    if (report.duplicates.length > 0) {
      const crossSourceDupes = report.duplicates.filter(
        d => d.photo1.source !== d.photo2.source
      );

      if (crossSourceDupes.length > 0) {
        recommendations.push(
          `Found ${crossSourceDupes.length} photos that exist in both Google Takeout and Synology. ` +
          `These can be safely deleted from Google Photos.`
        );
      }
    }

    if (recommendations.length === 0) {
      recommendations.push('All photos are synced and no duplicates found. Your library is in good shape!');
    }

    return recommendations;
  }

  async findPhotosToRemove(accountName?: string): Promise<PhotoRecord[]> {
    const duplicates = findDuplicates();
    const toRemove: PhotoRecord[] = [];

    for (const dup of duplicates) {
      let googlePhoto: PhotoRecord | null = null;
      let synologyPhoto: PhotoRecord | null = null;

      if (dup.photo1.source === 'google' && dup.photo2.source === 'synology') {
        googlePhoto = dup.photo1;
        synologyPhoto = dup.photo2;
      } else if (dup.photo1.source === 'synology' && dup.photo2.source === 'google') {
        googlePhoto = dup.photo2;
        synologyPhoto = dup.photo1;
      }

      if (googlePhoto && synologyPhoto) {
        if (!accountName || googlePhoto.accountName === accountName) {
          toRemove.push(googlePhoto);
        }
      }
    }

    return toRemove;
  }

  /**
   * Get photos that are backed up and safe to delete from Google
   */
  getPhotosSafeToDelete(accountName?: string): PhotoRecord[] {
    const db = getDatabase();
    let query = `
      SELECT * FROM photos
      WHERE source = 'google' AND is_backed_up = 1
    `;
    const params: string[] = [];

    if (accountName) {
      query += ' AND account_name = ?';
      params.push(accountName);
    }

    query += ' ORDER BY creation_time ASC';

    const rows = db.prepare(query).all(...params) as any[];
    return rows.map((row: any) => ({
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
    }));
  }

  /**
   * Reprocess already-synced photos to apply album tags.
   *
   * This tags source files with album names and marks them for re-upload.
   * When re-uploaded, Synology Photos will automatically read the EXIF tags.
   */
  async reprocessForAlbums(
    accountName: string,
    options: SyncOptions = {},
    onProgress?: (current: number, total: number, filename: string) => void
  ): Promise<{ tagged: number; skipped: number; failed: number; queuedForResync: number }> {
    const { limit, dryRun = config.dryRun, tagWithAlbum = false } = options;

    if (!tagWithAlbum) {
      throw new Error('--reprocess requires --tag-with-album option');
    }

    // Get all backed-up photos that have album names and source files
    const db = getDatabase();
    let query = `
      SELECT id, filename, synology_path, album_name FROM photos
      WHERE source = 'google' AND is_backed_up = 1
        AND album_name IS NOT NULL AND album_name != ''
        AND synology_path IS NOT NULL
    `;
    const params: string[] = [];

    if (accountName) {
      query += ' AND account_name = ?';
      params.push(accountName);
    }

    query += ' ORDER BY creation_time ASC';

    if (limit) {
      query += ' LIMIT ?';
      params.push(String(limit));
    }

    const rows = db.prepare(query).all(...params) as Array<{
      id: string;
      filename: string;
      synology_path: string;
      album_name: string;
    }>;

    logger.info(
      `${dryRun ? '[DRY RUN] ' : ''}Reprocessing ${rows.length} backed-up photos for album tagging...`
    );

    let tagged = 0;
    let skipped = 0;
    let failed = 0;
    let queuedForResync = 0;

    const tagWriter = new TagWriterService(dryRun);

    // Prepare statement for clearing is_backed_up flag
    const clearBackupStmt = db.prepare(`
      UPDATE photos SET is_backed_up = 0, backed_up_at = NULL WHERE id = ?
    `);

    try {
      for (let i = 0; i < rows.length; i++) {
        const { id, filename, synology_path: filePath, album_name: albumName } = rows[i];

        if (onProgress) {
          onProgress(i + 1, rows.length, filename);
        }

        // Check if source file still exists
        if (!fs.existsSync(filePath)) {
          logger.debug(`Source file not found for ${filename}, skipping...`);
          skipped++;
          continue;
        }

        try {
          const result = await tagWriter.writeAlbumTag(filePath, albumName);
          if (result.success) {
            tagged++;

            // Clear is_backed_up flag so this photo will be re-uploaded
            // The re-upload will overwrite the file on Synology with the tagged version
            if (!dryRun) {
              clearBackupStmt.run(id);
              queuedForResync++;
              logger.debug(`Queued ${filename} for re-upload with album tags`);
            }
          } else if (result.errorType === 'unsupported_format') {
            skipped++;
          } else {
            failed++;
          }
        } catch (error) {
          logger.warn(`Error tagging ${filename}: ${error}`);
          failed++;
        }
      }
    } finally {
      await tagWriter.close();
    }

    logger.info(
      `Reprocess complete: ${tagged} tagged, ${queuedForResync} queued for re-upload, ${skipped} skipped, ${failed} failed`
    );
    return { tagged, skipped, failed, queuedForResync };
  }

  /**
   * Retroactively add already-uploaded photos to Synology Photos albums.
   * This uses the Synology Photos API to create albums and add photos to them.
   */
  async fixAlbumsRetroactively(
    accountName: string,
    options: FixAlbumsOptions = {},
    onProgress?: (current: number, total: number, filename: string, status: string) => void
  ): Promise<FixAlbumsResult> {
    const { limit, batchSize = 100, dryRun = false } = options;

    // Find the paired Synology account
    const pairedSynology = getPairedSynologyAccount(config, accountName);
    if (!pairedSynology) {
      throw new Error(
        `No Synology account paired with "${accountName}". ` +
        `Configure PAIRING_*_GOOGLE and PAIRING_*_SYNOLOGY in .env`
      );
    }

    const synologyService = this.synologyServices.get(pairedSynology.name);
    if (!synologyService) {
      throw new Error(`Synology service not found for account: ${pairedSynology.name}`);
    }

    const result: FixAlbumsResult = {
      processed: 0,
      addedToAlbums: 0,
      albumsCreated: 0,
      photoIdsFound: 0,
      errors: 0,
      skipped: 0,
    };

    // Phase 1: Find Synology photo IDs for photos that don't have them yet
    logger.info('Phase 1: Looking up Synology photo IDs for backed-up photos...');
    const photosNeedingIds = getPhotosNeedingSynologyId(accountName);
    const idsToFind = limit ? photosNeedingIds.slice(0, limit) : photosNeedingIds;

    if (idsToFind.length > 0) {
      logger.info(`Found ${idsToFind.length} photos needing Synology photo ID lookup`);

      for (let i = 0; i < idsToFind.length; i++) {
        const photo = idsToFind[i];

        if (onProgress) {
          onProgress(i + 1, idsToFind.length, photo.filename, 'Looking up ID');
        }

        try {
          const synologyPhotoId = await synologyService.findPhotoByFilename(photo.filename);

          if (synologyPhotoId !== null) {
            if (!dryRun) {
              updatePhotoSynologyId(photo.id, synologyPhotoId);
            }
            result.photoIdsFound++;
            logger.debug(`Found Synology ID for ${photo.filename}: ${synologyPhotoId}`);
          } else {
            result.skipped++;
            logger.debug(`Could not find Synology ID for ${photo.filename}`);
          }
        } catch (error) {
          logger.warn(`Error looking up photo ID for ${photo.filename}: ${error}`);
          result.errors++;
        }

        // Rate limiting
        await this.delay(200);
      }

      logger.info(`Phase 1 complete: Found ${result.photoIdsFound} photo IDs, skipped ${result.skipped}`);
    } else {
      logger.info('Phase 1: All photos already have Synology photo IDs');
    }

    // Phase 2: Add photos to albums
    logger.info('Phase 2: Adding photos to Synology albums...');
    let photosToSync = getPhotosNeedingAlbumSync(accountName);

    if (limit) {
      photosToSync = photosToSync.slice(0, limit);
    }

    if (photosToSync.length === 0) {
      logger.info('Phase 2: No photos need album assignment');
      return result;
    }

    logger.info(`Found ${photosToSync.length} photos needing album assignment`);

    // Group photos by album for efficient batch processing
    const photosByAlbum = new Map<string, PhotoRecord[]>();
    for (const photo of photosToSync) {
      if (!photo.albumName) {
        result.skipped++;
        continue;
      }

      // Skip photos without Synology photo ID
      if (!photo.synologyPhotoId) {
        result.skipped++;
        continue;
      }

      if (!photosByAlbum.has(photo.albumName)) {
        photosByAlbum.set(photo.albumName, []);
      }
      photosByAlbum.get(photo.albumName)!.push(photo);
    }

    // Cache for album IDs to avoid repeated API calls
    const albumIdCache = new Map<string, number>();

    // Process each album
    for (const [albumName, photos] of photosByAlbum.entries()) {
      try {
        logger.info(`Processing album "${albumName}" (${photos.length} photos)`);

        let synologyAlbumId: number;

        // Get or create the album in Synology
        if (albumIdCache.has(albumName)) {
          synologyAlbumId = albumIdCache.get(albumName)!;
        } else {
          if (!dryRun) {
            // Check if album exists, create if not
            const existingAlbums = await synologyService.listAlbums();
            const existing = existingAlbums.find(a => a.name === albumName);

            if (existing) {
              synologyAlbumId = existing.id;
            } else {
              synologyAlbumId = await synologyService.getOrCreateAlbum(albumName);
              result.albumsCreated++;
            }

            albumIdCache.set(albumName, synologyAlbumId);
          } else {
            logger.info(`[DRY RUN] Would create/get album "${albumName}"`);
            synologyAlbumId = 0; // Placeholder for dry run
          }
        }

        // Get local album record
        let albumRecord;
        if (!dryRun) {
          albumRecord = getOrCreateAlbum(accountName, albumName, synologyAlbumId);
        }

        // Process photos in batches
        for (let i = 0; i < photos.length; i += batchSize) {
          const batch = photos.slice(i, i + batchSize);
          const photoIdsToAdd: number[] = [];

          for (const photo of batch) {
            if (onProgress) {
              onProgress(
                result.processed + 1,
                photosToSync.length,
                photo.filename,
                `Adding to "${albumName}"`
              );
            }

            if (photo.synologyPhotoId) {
              photoIdsToAdd.push(photo.synologyPhotoId);
            }
            result.processed++;
          }

          if (photoIdsToAdd.length > 0) {
            if (!dryRun) {
              // Add batch to album via API
              const success = await synologyService.addItemsToAlbum(synologyAlbumId, photoIdsToAdd);

              if (success) {
                // Update database records
                for (const photo of batch) {
                  if (photo.synologyPhotoId && albumRecord) {
                    addPhotoToAlbum(photo.id, albumRecord.id);
                    result.addedToAlbums++;
                  }
                }
              } else {
                result.errors += batch.length;
              }
            } else {
              logger.info(`[DRY RUN] Would add ${photoIdsToAdd.length} photos to album "${albumName}"`);
              result.addedToAlbums += photoIdsToAdd.length;
            }
          }

          // Rate limiting - small delay between batches
          await this.delay(1000);
        }
      } catch (error) {
        logger.error(`Error processing album "${albumName}": ${error}`);
        result.errors += photos.length;
        result.processed += photos.length;
      }
    }

    logger.info(
      `Fix albums complete: ${result.processed} processed, ${result.addedToAlbums} added to albums, ` +
      `${result.albumsCreated} albums created, ${result.errors} errors`
    );

    return result;
  }

  /**
   * Get album sync status for an account
   */
  getAlbumStatus(accountName: string): {
    totalWithAlbums: number;
    syncedToAlbums: number;
    needingSync: number;
    needingPhotoId: number;
    albums: Map<string, { needsSync: number; synced: number }>;
  } {
    const stats = getAlbumSyncStats(accountName);
    const needingIds = getPhotosNeedingSynologyId(accountName);

    let totalWithAlbums = 0;
    let syncedToAlbums = 0;
    let needingSync = 0;

    for (const [, { needsSync, synced }] of stats) {
      totalWithAlbums += needsSync + synced;
      syncedToAlbums += synced;
      needingSync += needsSync;
    }

    return {
      totalWithAlbums,
      syncedToAlbums,
      needingSync,
      needingPhotoId: needingIds.length,
      albums: stats,
    };
  }

  /**
   * Sanitize album name to be a valid folder name.
   * Handles invalid characters, path traversal attempts, and edge cases.
   */
  private sanitizeAlbumName(name: string): string {
    const trimmed = name.trim();
    const sanitized = trimmed
      .replace(/[<>:"/\\|?*]/g, '_')       // Replace invalid filesystem chars
      .replace(/\.{2,}/g, '_')             // Prevent path traversal (.., ...)
      .replace(/^[./\\]+/, '')             // Remove leading dots/slashes
      .trim()                              // Trim again after replacements
      || 'Untitled Album';                 // Fallback for empty result

    // Log when sanitization changes the name (helps diagnose collisions)
    if (sanitized !== trimmed) {
      logger.debug(`Album name sanitized: "${trimmed}" -> "${sanitized}"`);
    }

    return sanitized;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async cleanup(): Promise<void> {
    for (const service of this.synologyServices.values()) {
      await service.logout();
    }
  }
}
