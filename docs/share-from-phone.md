# Sharing a job into Diligently from a phone

Both paths open New job with the job already filled in. A link lands on the
Job link tab; shared text with no link lands in the description box.
`web/src/features/apply/sharedJob.ts` reads the address, and it takes the
first link it finds in `url`, `text` or `title`, because apps put it in
different places.

## Android

`web/public/site.webmanifest` declares a share target. Once someone installs
Diligently from Chrome or Edge (menu, then Install app or Add to Home
screen), it appears in the share sheet. Sharing a posting from LinkedIn, a job
board or the browser opens:

```
https://<domain>/new?title=...&text=...&url=...
```

Signed out, the person signs in and comes back to the same address. Only an
installed app shows in the share sheet, so the install step is the one to
explain to people. This has not been tried on a real phone yet.

## iPhone

Safari does not let web apps join the share sheet (WebKit bug 194593, open
since 2019). A Shortcut does the same job. Build it once, then share its
iCloud link so people can add it with one tap.

In the Shortcuts app:

1. Create a shortcut named **Send to Diligently**.
2. In its details, turn on **Show in Share Sheet** and limit the input to
   URLs, Safari web pages and Text.
3. Set **If there is no input** to **Get Clipboard**, so it also works from
   the Shortcuts list after copying a link.
4. Add **Get URLs from Input** on the Shortcut Input.
5. Add **If** URLs **has any value**:
   - **Get Item from List** (First Item) on URLs
   - **URL Encode** that item
   - **Open URLs** `https://<domain>/new?url=` followed by the encoded text
6. **Otherwise**:
   - **URL Encode** the Shortcut Input
   - **Open URLs** `https://<domain>/new?text=` followed by the encoded text
7. Share it with **Copy iCloud Link** and put the link on the site, for
   example under Settings or in the welcome email.

Replace `<domain>` with the production domain once it exists. The action
names above are from the iOS Shortcuts app and should be checked on a
current iPhone when the shortcut is built.
