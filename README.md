# AgriKountr

Billing, stock, GST, udhaar and accounts for fertilizer, pesticide and seed shops.
Bills enter themselves from a photo. Telugu first, works without internet.

ఎరువులు, పురుగు మందులు, విత్తనాల షాపుల కోసం బిల్లింగ్, స్టాక్, GST, బాకీలు, ఖాతాలు.
బిల్లు ఫోటో తీస్తే చాలు. ఇంటర్నెట్ లేకపోయినా పని చేస్తుంది.

## How it works

- **Shop computer (Windows):** the main copy of the shop's data. It also runs a small server that phones connect to over the shop Wi-Fi.
- **Phones (Android):** pair once with a 6-digit code or QR. They work offline and sync whenever they are back on the shop Wi-Fi.
- **Internet is only needed for** reading bill photos with AI (photos wait in a queue when offline) and optional backup.
- **No cloud server.** Each shop's data stays on its own computer, with a daily backup.

## Getting the apps (one-time setup, about 10 minutes)

1. On github.com create an empty **private** repository named `agrikountr`.
2. Put this code in it (Claude does this once the repository exists).
3. GitHub builds the apps automatically: open the repository → **Actions** → the latest **Build apps** run → **Artifacts**:
   - `AgriKountr-Windows-Setup` → unzip → run `AgriKountr Setup.exe` on the shop computer
   - `AgriKountr-Android-APK` → unzip → copy `AgriKountr.apk` to the phone → open it → allow "install unknown apps"

## First day in the shop

1. Install and open AgriKountr on the shop computer. If Windows asks about the firewall, tap **Allow** (needed for phones).
2. Click the badge at the top right → **AI bill reader** → paste the AI key (from console.anthropic.com) → **Save key**.
3. Open **షాప్ వివరాలు · Shop details**: shop name, address, GSTIN, state, invoice prefix, godown names, UPI ID.
4. Open **లైసెన్సులు · Licences**: photograph each licence.
5. Connect each phone: on the computer click the badge → choose **Staff** or **Owner** → a QR and code appear.
   On the phone open AgriKountr → **Photograph the QR**. Phone and computer must be on the same Wi-Fi
   (or the computer joined to the phone's hotspot).
6. Photograph the last few company bills and the old khata pages so the shop starts with real stock and dues.

## Dealer sales and e-way bills

**Dealer sale:** on Sell, tap **డీలర్ / రిటైలర్ · Dealer (B2B)**. Type or pick the dealer, then the GSTIN, town and PIN. Dealer prices are remembered for each product, and you can tap any price to change it.

**When is an e-way bill needed?** When goods worth more than ₹50,000 move by vehicle. In Telangana this applies inside the state and to other states. Seeds (0% GST, exempt) are not counted. The app shows the e-way bill box by itself when it is needed.

**Three ways to make it:**
1. **Direct, with no portal login.** This needs a one-time setup on the shop computer, under Settings → E-way bill link:
   - Log in at ewaybillgst.gov.in.
   - Go to **Registration → For GSP**, enter the OTP, choose **Add/New**, choose our partner, and make an API username and password.
   - Type them into the app and press **Test**.
   - After that, every dealer bill makes its e-way bill by itself, even from the phone. The phone needs to be on the shop Wi-Fi.
2. **Portal file:** tap **Portal file**. On ewaybillgst.gov.in, go to e-Way Bill → **Generate Bulk** and upload the file. Then type the number into the app, or photograph the e-way bill's QR.
3. **Made elsewhere:** type the 12-digit number.

Once the bill has an e-way bill, you can send it to the driver on WhatsApp, change the vehicle, or cancel it within 24 hours.

**Practice mode** makes pretend numbers so staff can learn the steps. These are marked PRACTICE everywhere and are not valid on the road.

Invoice numbers now have at most 16 characters, as GST requires: `KK/2627/0001` on the computer, `KK/2627/B0001` on phone B.

## Checking bill photos

Every bill photo goes through:
1. GST e-invoice QR (exact GSTIN, bill number, date, total, when the supplier prints one)
2. AI reading of every line (English, Telugu, Hindi, printed or handwritten)
3. Checks: qty × rate = amount, lines = bill total, GSTIN check digit, GST rate for the product, HSN, expiry, duplicates
4. A second, more careful AI reading when something does not add up
5. The on-device reader on the shop computer (works offline) confirms each number is really on the photo
6. The dealer checks only the lines marked in orange, then saves

## Google Drive backup (data safe in the cloud)

**For the dealer (shop computer, about 2 minutes):** tap the connection badge, then go to **Google Drive backup**.
1. Choose a backup PIN of 6 to 12 digits. Write it on paper and keep it with your licences. Without the PIN nobody can open the backup, not even us.
2. Tap **Sign in with Google**, press **Allow** in the browser, and come back.

After that, the computer saves a locked copy to the shop's own Google Drive every day. It is kept in the folder "AgriKountr Backups": the last 14 copies, plus one per month for a year. The home screen shows **✓ Data safe**. If it shows a red warning, the backup has stopped.

**New computer:** install the app, tap **New computer? Restore old data**, sign in with the same Google account, pick the backup, and type the PIN. Phones keep working once they are reconnected.

The backup leaves out these secrets: the AI key and the e-way bill password. Type them again after a restore.

**For us, once, before giving the app to dealers (Google Cloud console):**
1. Create a project, then enable the **Google Drive API**.
2. Set up the OAuth consent screen:
   - User type **External**.
   - App name "AgriKountr", logo, support email, and a privacy policy web page.
   - Scope: only `.../auth/drive.file`, which Google rates non-sensitive and needs only basic verification.
3. Create credentials: OAuth client ID → **Desktop app**.
4. Press **Publish app** to move it to "In production". In "Testing", Google ends every sign-in after 7 days.
5. In GitHub, go to Settings → Secrets → Actions and add `KK_GOOGLE_CLIENT_ID` and `KK_GOOGLE_CLIENT_SECRET`. The next build includes them.

## Backups

The computer keeps a copy every 6 hours (last 30 days) in its data folder (tray icon → Open data folder).
Add a Google Drive or pen-drive folder in the connect panel → **Backup** for a second copy.

## For developers

```
web/        the app screens (same on phone and computer); platform.js = storage, sync, AI, voice
desktop/    Electron app + server.js (sync, pairing, AI relay, OCR checker, backups)
mobile/     Capacitor Android app (built in GitHub Actions)
.github/workflows/build.yml   builds the Windows installer and the APK
```

Run the server without Electron for testing:

```
cd desktop && npm install --omit=dev && node server.js
# computer: http://127.0.0.1:8765   phones on the same network: http://<computer-ip>:8765
```

Sync rules: whole documents, last write wins, except stock by place and party dues, which travel as
changes (−1 bag, +₹500) so offline devices never overwrite each other. Each phone has its own invoice
series (e.g. `KK/26-27/MAB3-0001`), so offline bills never share a number.
