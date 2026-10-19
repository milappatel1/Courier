# Setting up Gmail sign-in

Courier talks to Gmail directly from your Mac. For that, Google wants an "OAuth client": a small record in a
Google Cloud project that says "this app may ask me for access to my mail". You make it once, in your own Google
account, and it costs nothing. It takes about ten minutes.

You'll end up with two values, a **client ID** and a **client secret**, which you paste into Courier. They stay in
your Mac's Keychain.

## 1. Make a project

1. Go to <https://console.cloud.google.com/> and sign in with your Google account.
2. At the top left, click the project picker (it may say "Select a project"), then **New project**.
3. Name it `Courier` and click **Create**. When it's done, make sure the picker shows **Courier**.

## 2. Turn on the Gmail API (and contacts, for address suggestions)

1. In the search bar at the top, type **Gmail API**, open it and click **Enable**.
2. Search for **People API**, open it and click **Enable**. (Optional: without it, Courier still suggests
   addresses from your mail.)

## 3. Describe the app to Google (the consent screen)

1. Search for **Google Auth Platform** (or go to **APIs & Services ▸ OAuth consent screen**) and click **Get
   started**.
2. **App information**: app name `Courier`, and pick your own email as the support email. **Next**.
3. **Audience**: choose **External**. **Next**.
4. **Contact information**: your email again. **Next**, tick the agreement, **Create**.
5. Open **Audience** in the left menu. Under **Test users**, click **Add users** and add every Gmail address you
   want to use in Courier. **Save**.
6. Open **Data access** in the left menu, click **Add or remove scopes**, and add these (paste them into "Manually
   add scopes" at the bottom, then **Add to table**, **Update**, **Save**):

   ```
   https://mail.google.com/
   https://www.googleapis.com/auth/gmail.settings.basic
   https://www.googleapis.com/auth/gmail.settings.sharing
   https://www.googleapis.com/auth/contacts.readonly
   https://www.googleapis.com/auth/contacts.other.readonly
   ```

## 4. Make the client

1. Open **Clients** in the left menu and click **Create client**.
2. **Application type**: **Desktop app**. Name: `Courier for Mac`. Click **Create**.
3. A box shows the **Client ID** and **Client secret**. Click **Download JSON** (or keep the box open to copy the
   two values).

For a desktop app the "secret" isn't really secret (Google says so too), but treat it like a password anyway:
don't post it, and don't put it in a repository.

## 5. Give it to Courier

1. In Courier, open **Settings ▸ Accounts** and find **Google sign-in setup**.
2. Click **Import JSON…** and pick the file you downloaded (it's saved straight away), or paste the client ID
   and secret and click **Save**. The row then says **Set up**.
3. Choose **Add account ▸ Gmail ▸ Sign in with Google**. Your browser opens.
4. Pick your account. Google shows **"Google hasn't verified this app"**: that's expected, because the app is
   yours and only your test users can use it. Click **Continue**, tick the boxes for the access Courier asks
   for, and click **Continue** again.
5. The browser says you can close the tab. Back in Courier your mail starts syncing.

## Good to know

- **Weekly sign-in**: while the consent screen is in **Testing**, Google lets a sign-in last 7 days. After that
  Courier asks you to sign in again (your mail and settings stay). To stop that, go to **Audience** and click
  **Publish app**. Google doesn't need to review an app only you use; you'll keep seeing the "hasn't verified"
  page when signing in.
- **Removing access**: <https://myaccount.google.com/permissions> lists Courier; remove it there to revoke
  access everywhere. Signing out in Courier removes the sign-in from your Mac.
- **Changing the client**: in Settings ▸ Accounts ▸ Google sign-in setup, click **remove** next to "Set up", then
  save the new one. Existing Gmail accounts then need to sign in again.
