# AmpOhm — Expo App (source for the real APK)

This is the native React Native / Expo version of AmpOhm, structured to
mirror the web build (`app.js`) exactly — same calculators, same
translations, same formulas. No ads are wired in — this is a plain
Expo app with no native modules beyond AsyncStorage, so it works in
the regular **Expo Go** app too (no custom dev client needed).

## What's in here
```
ampohm-app/
  App.js              — all screens, calculators, UI
  src/translations.js — English + Hindi text (synced from the web app)
  src/storage.js        — saves the user's language choice on-device
  app.json              — Expo config
  eas.json              — cloud build profiles
  package.json
  babel.config.js
```

## 1. Set up the project locally
I can't run `npm install` or build an APK inside this sandbox (no
internet access here), so this last mile happens on your computer.

```bash
# 1. Install dependencies
cd ampohm-app
npm install

# 2. Auto-fix any version mismatches for your installed Expo SDK
#    (package.json pins versions that were current when this was
#    written — Expo releases often, so this command self-corrects)
npx expo install --fix
```

## 2. Test it on your phone (fast, no build needed)
Since there's no native module here anymore, plain **Expo Go** works:

```bash
npx expo start
```
Scan the QR code with the Expo Go app (Play Store) — the app opens
instantly with live-reload. No login, no cloud build needed for this step.

## 3. Build the real, shareable APK
When you're happy with it:
```bash
npx eas login          # free Expo account — sign up at expo.dev if you don't have one
npx eas build:configure
eas build -p android --profile preview
```
This builds in the cloud (10–20 min) and gives you a download link for
a real, installable `.apk` — this is the one to test fully and share
before Play Store submission.

For the **Play Store** itself, use:
```bash
eas build -p android --profile production
```
This produces an `.aab` (Android App Bundle), which is what Play
Console expects.

## Notes
- Update `android.package` in `app.json` (currently
  `com.audioxpert.ampohm`) if you want a different package name — it
  can't be changed after your first Play Store upload.
- Before submitting to Play Store, host `privacy-policy.html` (from
  the web build) somewhere public and add that link in Play Console —
  Play Store requires this for every app, ads or not.
- If you want to add monetization back later (AdMob or otherwise),
  that's a separate native module and will again require a custom
  dev client build (not plain Expo Go) — same as before.
