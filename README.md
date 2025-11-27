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
3. **Uploads** only NEW photos to your Synology (skips duplicates)
4. **Tells you** which photos are safe to delete from Google (with date ranges)
5. **Preserves dates** by reading the JSON metadata files from Google Takeout

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

## License

MIT — free to use and modify.
