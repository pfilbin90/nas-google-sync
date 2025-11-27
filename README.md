# NAS-Google-Sync

**Free up Google storage by backing up your photos to a Synology NAS.**

Google killed their Photos API in March 2025. This tool works around that by importing your photos from Google Takeout and uploading them to Synology Photos.

## What It Does

- **Imports** your Google Takeout photo export
- **Detects duplicates** so you don't upload photos twice
- **Uploads** new photos to your Synology NAS
- **Tells you** which photos are safely backed up (so you can delete them from Google)
- **Preserves dates** by reading the JSON metadata files that Google Takeout includes

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
SYNOLOGY_HOST=192.168.1.100       # Your NAS IP address
SYNOLOGY_PORT=5000
SYNOLOGY_ACCOUNTS=myaccount

SYNOLOGY_myaccount_USERNAME=your_synology_username
SYNOLOGY_myaccount_PASSWORD=your_synology_password
SYNOLOGY_myaccount_PHOTO_PATH=/homes/your_synology_username/Photos

GOOGLE_ACCOUNTS=mygoogle
PAIRING_1_GOOGLE=mygoogle
PAIRING_1_SYNOLOGY=myaccount
```

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
SYNOLOGY_ACCOUNTS=user1,user2

# User 1 (you)
SYNOLOGY_user1_USERNAME=your_username
SYNOLOGY_user1_PASSWORD=your_password
SYNOLOGY_user1_PHOTO_PATH=/homes/your_username/Photos

# User 2 (spouse)
SYNOLOGY_user2_USERNAME=spouse_username
SYNOLOGY_user2_PASSWORD=spouse_password
SYNOLOGY_user2_PHOTO_PATH=/homes/spouse_username/Photos

GOOGLE_ACCOUNTS=me,spouse
PAIRING_1_GOOGLE=me
PAIRING_1_SYNOLOGY=user1
PAIRING_2_GOOGLE=spouse
PAIRING_2_SYNOLOGY=user2
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
| `node dist/index.js workflow` | Show detailed step-by-step guide |

---

## Deleting Photos from Google

Google doesn't let apps delete photos. After confirming your backup, use [Google Photos Toolkit](https://github.com/xob0t/Google-Photos-Toolkit) (a free browser extension) to bulk-delete by date range.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Authentication failed | Add your Synology user to the Administrators group |
| 0 new photos found | Photos already exist on Synology (detected by file hash) |
| Multiple ZIP files | Extract all ZIPs to the same folder before importing |

---

## License

MIT — free to use and modify.
