import fs from 'fs';
import path from 'path';
import { loadConfig, getPairedSynologyAccount } from '../config.js';
import { logger } from '../utils/logger.js';
import { SynologyPhotosService } from './synology-photos.js';
import { GoogleTakeoutService, TakeoutPhoto, TakeoutScanResult } from './google-takeout.js';
import {
  getPhotoStats,
  findDuplicates,
  getPhotosNotBackedUp,
  markAsBackedUp,
  getStorageStats,
  PhotoRecord,
  getPhotosBySource,
  getDatabase,
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
    };

    // Scan the takeout folder
    const takeoutService = new GoogleTakeoutService(accountName);
    const scanResult = await takeoutService.scanTakeoutFolder(takeoutPath, onProgress);

    result.totalScanned = scanResult.photos.length;
    result.errors = scanResult.errors;

    // Get existing photos from database for comparison
    const existingSynologyPhotos = this.getAllSynologyPhotoHashes();
    const existingTakeoutHashes = new Set<string>();

    // Check each photo for duplicates
    const newPhotos: TakeoutPhoto[] = [];

    for (const photo of scanResult.photos) {
      if (existingSynologyPhotos.has(photo.hash)) {
        result.duplicatesInSynology++;
      } else if (existingTakeoutHashes.has(photo.hash)) {
        result.duplicatesInTakeout++;
      } else {
        newPhotos.push(photo);
        existingTakeoutHashes.add(photo.hash);
      }
    }

    result.newPhotos = newPhotos.length;

    // Import new photos to database
    await takeoutService.importToDatabase(newPhotos);

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

  /**
   * Sync photos from takeout to Synology
   */
  async syncToSynology(
    accountName: string,
    count: number = 100,
    dryRun: boolean = config.dryRun,
    onProgress?: (current: number, total: number, filename: string) => void
  ): Promise<{ synced: number; failed: number; skipped: number }> {
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
    const photosToSync = getPhotosNotBackedUp(accountName).slice(0, count);

    logger.info(
      `${dryRun ? '[DRY RUN] ' : ''}Syncing ${photosToSync.length} photos from ${accountName} ` +
      `to ${pairedSynology.name}'s Synology Photos...`
    );

    let synced = 0;
    let failed = 0;
    let skipped = 0;

    for (let i = 0; i < photosToSync.length; i++) {
      const photo = photosToSync[i];

      if (onProgress) {
        onProgress(i + 1, photosToSync.length, photo.filename);
      }

      // For takeout imports, we need the original file path
      // The ID format is: takeout-{accountName}-{hash}
      // We need to find the actual file

      // Check if we have a file path stored (we store it in synologyPath temporarily for takeout)
      const db = getDatabase();
      const row = db.prepare(`
        SELECT synology_path FROM photos WHERE id = ?
      `).get(photo.id) as { synology_path?: string } | undefined;

      const filePath = row?.synology_path;

      if (!filePath || !fs.existsSync(filePath)) {
        logger.warn(`File not found for ${photo.filename}, skipping...`);
        skipped++;
        continue;
      }

      try {
        if (dryRun) {
          logger.info(`[DRY RUN] Would sync: ${photo.filename} (${photo.creationTime})`);
          synced++;
        } else {
          logger.info(`Uploading: ${photo.filename}`);
          const buffer = fs.readFileSync(filePath);
          const success = await synologyService.uploadPhoto(buffer, photo.filename);

          if (success) {
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

    logger.info(`Sync complete: ${synced} synced, ${failed} failed, ${skipped} skipped`);
    return { synced, failed, skipped };
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

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async cleanup(): Promise<void> {
    for (const service of this.synologyServices.values()) {
      await service.logout();
    }
  }
}
