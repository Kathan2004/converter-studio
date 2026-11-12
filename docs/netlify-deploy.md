# Netlify Deployment Guide (Converter Studio)

This project is already separated into one folder:
- [md-pdf-tool](Converter Studio)

## Current status

- Netlify login worked.
- Live site: https://converterstudio.netlify.app
- CLI deploy upload failed with HTTP 403 due corporate Zscaler network filtering.

This is a network policy issue, not a code issue.

## Recommended deployment path (works around corporate proxy)

Use Git-based deploy from Netlify web dashboard so Netlify pulls from Git provider servers, not from your blocked local upload path.

## Step-by-step (GitHub + Netlify)

1. Create a new GitHub repo.
2. From folder [md-pdf-tool](Converter Studio), run:

```powershell
git add .
git commit -m "Initial Converter Studio"
git branch -M main
git remote add origin <YOUR_GITHUB_REPO_URL>
git push -u origin main
```

3. Open Netlify dashboard.
4. Choose Add new site -> Import an existing project.
5. Select your GitHub repo.
6. Build settings:

- Base directory: leave empty
- Build command: leave empty
- Publish directory: .

7. Deploy site.

Netlify will use [netlify.toml](netlify.toml) and detect functions in [netlify/functions/md-to-pdf.js](netlify/functions/md-to-pdf.js).

## Verify after deploy

Open:
- https://<your-site>.netlify.app/index.html

Check:
- UI loads
- Paste/upload markdown works
- PDF downloads
- TOC toggle/depth works

## If you still want CLI deploy from this machine

Your network must allow Netlify upload endpoints (currently blocked by Zscaler). Once allowed, this works:

```powershell
$env:NODE_TLS_REJECT_UNAUTHORIZED="0"
npx.cmd netlify deploy --build --prod
```

(Use only in trusted internal environment. Preferred: fix corporate certificates and remove this override.)
