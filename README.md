# NAS-Google-Sync

**Free up Google storage by backing up your photos to a Synology NAS.**

Google killed their Photos API in March 2025. This tool works around that by importing your photos from Google Takeout and uploading them to Synology Photos.

---

## Before You Start: Fix Your Photo Dates

Google Takeout strips metadata (dates, locations) from your photos and stores it in separate JSON files. This tool reads those JSON files, but **your photos will still have wrong dates embedded in them**.

If you want your photos to have correct dates when viewed in Synology Photos (or any other app), run **[Google Takeout Metadata Restorer](https://github.com/pfilbin90/google-takeout-metadata-restorer)** on your Takeout folder first. It embeds the dates and locations back into your actual photo files.

**Recommended workflow:**
1. Download and extract your Google Takeout
2. Run [google-takeout-metadata-restorer](https://github.com/pfilbin90/google-takeout-metadata-restorer) to fix embedded dates
3. Then use this tool (nas-google-sync) to upload to Synology

---

## What It Does

1. **Scans** your Synology NAS to see what photos you already have
2. **Imports** your Google Takeout export and detects duplicates
3. **Detects albums** from the Google Takeout folder structure
4. **Uploads** only NEW photos to your Synology (skips duplicates)
5. **Preserves album structure** via folder organization or EXIF tags (optional)
6. **Tells you** which photos are safe to delete from Google (with date ranges)
7. **Preserves dates** by reading the JSON metadata files from Google Takeout

---

## Quick Start (Single User)

### 1. Install Node.js

Download and install from **https://nodejs.org** (click the LTS version).

To verify it worked, open a terminal and type:
```
node --version
```

### 2. Download This Tool

**Option A:** Click the green "Code" button above → "Download ZIP" → Extract it

**Option B:** Or use git:
```
git clone https://github.com/pfilbin90/nas-google-sync.git
```

### 3. Install & Build

Open a terminal/command prompt in the extracted folder:
```
npm install
npm run build
```

### 4. Configure

1. Copy `.env.example` to `.env`
2. Open `.env` in a text editor and fill in your Synology details:

```env
SYNOLOGY_HOST=192.168.1.100
SYNOLOGY_PORT=5000

SYNOLOGY_USERNAME=your_synology_username
SYNOLOGY_PASSWORD=your_synology_password
SYNOLOGY_PHOTO_PATH=/homes/your_synology_username/Photos

GOOGLE_ACCOUNT=mygoogle
```

That's it! Just 6 values to fill in.

> **Note:** Your Synology user must be in the **Administrators group** (DSM 7 requirement).

### 5. Export Your Photos from Google

1. Go to [takeout.google.com](https://takeout.google.com)
2. Click "Deselect all"
3. Scroll down and check **Google Photos**
4. Click "Next step" → Create export
5. Wait for Google's email, then download and extract the ZIP file(s)

> **Tip:** If you get multiple ZIP files, extract them all into the same folder.

### 6. Run It

```bash
# First, scan your Synology to find existing photos
node dist/index.js scan

# Import the Google Takeout
node dist/index.js import "C:\path\to\Takeout\Google Photos" --account mygoogle

# Upload to Synology
node dist/index.js sync --account mygoogle

# See what's safe to delete from Google
node dist/index.js export --format dates --account mygoogle
```

> **Note:** If your path has spaces, make sure the entire command is on one line.

---

## Multiple Users (You + Spouse)

Each person needs their own Google Takeout export and their own Synology account.

### Configure for Two Users

```env
SYNOLOGY_HOST=192.168.1.100
SYNOLOGY_PORT=5000

# User 1 (you)
SYNOLOGY_USERNAME=your_username
SYNOLOGY_PASSWORD=your_password
SYNOLOGY_PHOTO_PATH=/homes/your_username/Photos
GOOGLE_ACCOUNT=me

# User 2 (spouse)
SYNOLOGY_2_USERNAME=spouse_username
SYNOLOGY_2_PASSWORD=spouse_password
SYNOLOGY_2_PHOTO_PATH=/homes/spouse_username/Photos
GOOGLE_ACCOUNT_2=spouse
```

### Run for Each Person

**Step 1:** Each person exports from [takeout.google.com](https://takeout.google.com) and extracts to separate folders.

**Step 2:** Import and sync each account separately:

```bash
# Scan Synology first (only needed once)
node dist/index.js scan

# YOUR photos
node dist/index.js import "C:\Takeout\me" --account me
node dist/index.js sync --account me

# SPOUSE's photos
node dist/index.js import "C:\Takeout\spouse" --account spouse
node dist/index.js sync --account spouse
```

**Step 3:** See what each person can delete from Google:

```bash
# Your backed-up photos
node dist/index.js export --format dates --account me

# Spouse's backed-up photos
node dist/index.js export --format dates --account spouse
```

Each person then deletes from their **own** Google Photos account based on their date ranges.

---

## Commands

| Command | What it does |
|---------|--------------|
| `node dist/index.js scan` | Index photos already on your Synology |
| `node dist/index.js import <path> --account <name>` | Import a Google Takeout folder |
| `node dist/index.js sync --account <name>` | Upload new photos to Synology |
| `node dist/index.js albums` | List albums detected from Google Takeout |
| `node dist/index.js fix-albums --account <name>` | Add already-uploaded photos to Synology albums |
| `node dist/index.js retag <path>` | Apply album tags to photos in a takeout folder |
| `node dist/index.js export --format dates --account <name>` | Show backed-up photos for that account |
| `node dist/index.js inspect` | Verify duplicate detection is working |
| `node dist/index.js workflow` | Show detailed step-by-step guide |

### Sync Options

By default, `sync` uploads **all** pending photos in one go. For large libraries, you may want to upload in batches:

```bash
# Upload ALL photos at once (default)
node dist/index.js sync --account mygoogle

# Upload in batches of 100
node dist/index.js sync --account mygoogle -n 100

# Test with just 5 photos first
node dist/index.js sync --account mygoogle -n 5

# Preview what would be uploaded (no actual upload)
node dist/index.js sync --account mygoogle --dry-run
```

> **Tip:** If you have thousands of photos, consider starting with `-n 50` to make sure everything works, then run without `-n` to upload the rest.

### Album Preservation

Google Takeout organizes photos into folders matching your album names (e.g., `Trip to Florida/`, `Family Reunion 2023/`). **By default, album names are automatically embedded in photo EXIF tags** (XMP:Subject and IPTC:Keywords fields) so you can create albums in Synology Photos later.

```bash
# Default behavior - uploads photos with album tags embedded
node dist/index.js sync --account mygoogle

# Also create album folders on Synology (in addition to tags)
# Photos go into /Photos/AlbumName/ subfolders
node dist/index.js sync --account mygoogle --organize-by-album

# Skip album tagging if you don't want it
node dist/index.js sync --account mygoogle --no-tag-with-album
```

| Option | What it does |
|--------|--------------|
| *(default)* | Embeds album name in photo metadata (XMP:Subject, Keywords). Synology Photos can create albums from these tags later |
| `--organize-by-album` | Creates folders on Synology matching album names. Photos upload to `/Photos/Trip to Florida/` instead of `/Photos/` |
| `--no-tag-with-album` | Skips embedding album names in EXIF tags (not recommended) |

**When to use `--organize-by-album`?**

- You want folder-based organization in Synology File Station
- You want both folder structure AND embedded tags
- You're okay with more complex folder structures

**When to use `--no-tag-with-album`?**

- You're concerned about modifying original photo files
- You have very large files and want faster sync times
- You only want folder-based organization (use with `--organize-by-album`)

> **Note:** The `--tag-with-album` option requires `exiftool` (bundled automatically). It only works on supported image formats (JPEG, PNG, TIFF, HEIC). Videos are skipped for tagging.

### Fix Albums Command (Retroactive Album Assignment)

If you've already uploaded photos to Synology before enabling album preservation, you can retroactively add them to Synology Photos albums:

```bash
# Add already-uploaded photos to Synology albums
node dist/index.js fix-albums --account mygoogle

# Preview what would happen without making changes
node dist/index.js fix-albums --account mygoogle --dry-run

# Process only 100 photos (for testing)
node dist/index.js fix-albums --account mygoogle -n 100

# Control batch size (default: 100)
node dist/index.js fix-albums --account mygoogle --batch-size 50
```

**How it works:**
1. **Phase 1:** Looks up Synology photo IDs for your backed-up photos
2. **Phase 2:** Creates albums in Synology Photos and adds photos to them

This uses the Synology Photos API directly, so albums appear in the Synology Photos UI immediately - no EXIF tags or re-uploads needed.

**Progress tracking:**
The command shows status before processing:
```text
========== Album Sync Status for mygoogle ==========
  Photos with album assignments: 15,000
  Already in Synology albums: 0
  Needing album assignment: 15,000
  Needing Synology photo ID: 15,000
```

**Performance considerations:**
- Processing 70,000+ photos can take several hours
- The tool processes 100 photos per batch by default
- Use `--batch-size` to adjust if you have rate limiting issues
- Use `-n` to test with a small number first

> **Note:** This requires photos to already be uploaded to Synology Photos and indexed. Run a `scan` first if you just uploaded photos.

### Retag Command (Tag Without Syncing)

If you want to apply album tags to photos without using this tool's sync feature:

```bash
# Apply album tags directly to takeout folder
node dist/index.js retag "C:\path\to\Takeout\Google Photos"

# Preview what would be tagged
node dist/index.js retag "C:\path\to\Takeout\Google Photos" --dry-run

# Tag only first 50 photos as a test
node dist/index.js retag "C:\path\to\Takeout\Google Photos" -n 50
```

This writes album names to photo EXIF tags (XMP:Subject, IPTC:Keywords). You can then upload the tagged photos to any photo service that reads these tags.

### Albums Command

After importing, see what albums were detected:

```bash
# List all detected albums with photo counts
node dist/index.js albums

# Filter by account
node dist/index.js albums --account mygoogle

# Show more albums (default: 50)
node dist/index.js albums -n 100
```

Example output:
```text
========== DETECTED ALBUMS ==========

  Total albums: 47
  Photos in albums: 3,842

  Trip to Florida: 234 photos
  Family Reunion 2023: 156 photos
  Birthday Party: 89 photos
  ...
```

### Inspect Command Options

Use `inspect` to debug and verify that duplicate matching is working:

```bash
# Search for a specific photo in both Synology and Takeout
node dist/index.js inspect --search "IMG_1234.jpg"

# Show photos that exist in BOTH sources (matched duplicates)
node dist/index.js inspect --matched

# Show sample Synology photos with their dates
node dist/index.js inspect --synology

# Show photos marked as "new" (not found on Synology)
node dist/index.js inspect --new

# Control how many results to show (default: 20)
node dist/index.js inspect --synology -n 50
```

---

## Deleting Photos from Google

Google doesn't let apps delete photos. After confirming your backup, use [Google Photos Toolkit](https://github.com/xob0t/Google-Photos-Toolkit) (a free browser extension) to bulk-delete by date range.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Authentication failed | Add your Synology user to the Administrators group in DSM |
| 0 new photos found | All photos already exist on Synology - that's good! |
| Multiple ZIP files | Extract all ZIPs into the same folder before importing |
| "Already on Synology" count is 0 | Make sure you ran `scan` before `import` |
| Wrong dates on photos | Check if the `.supplemental-metadata.json` files exist in your Takeout |

---

## How Scanning Works

The `scan` command indexes photos from your Synology NAS so the tool can detect duplicates. It scans two locations:

1. **Personal Space** - Your private photos in `/homes/<username>/Photos`
2. **Shared Space** - Photos in the shared `/photo` folder

### Multiple Users with Shared Space

If you and your spouse both have accounts and share the same Shared Space, don't worry - the tool handles this correctly:

- Each user's **Personal Space** photos are tracked separately
- **Shared Space** photos are tracked globally (not per-user)
- When both users run `scan`, shared photos are only counted once

This means you won't get inflated photo counts or false duplicates when multiple family members use the tool.

---

## How Duplicate Detection Works

The tool matches photos between Google Takeout and Synology using:
1. **Filename + Date** - Same filename taken on the same day
2. **File hash** - Identical file content (when available)

Photos that match are marked as "Already on Synology" and won't be uploaded again. They're also included in the export so you know they're safe to delete from Google.

---

## How Album Detection Works

When you import a Google Takeout, the tool detects albums from the folder structure:

```text
Google Photos/
├── Trip to Florida/          ← Album: "Trip to Florida"
│   ├── IMG_001.jpg
│   └── IMG_002.jpg
├── Family Reunion 2023/      ← Album: "Family Reunion 2023"
│   └── DSC_100.jpg
├── Photos from 2023/         ← Skipped (auto-generated date folder)
│   └── photo.jpg
└── IMG_999.jpg               ← No album (root level)
```

**Albums are detected** from the first-level subfolder names under `Google Photos/`.

**Auto-generated folders are skipped**, including:
- `Photos from YYYY` (Google's date-based folders)
- Date-pattern folders like `2024-01-15`
- `Untitled`, `Archive`, `Trash`

After import, run `node dist/index.js albums` to see all detected albums and their photo counts.

---

## License

MIT — free to use and modify.
