# Brand assets

`delta-wordmark.webp` is the logo the web app renders — the auth pages, the
quotation preview, and the four printable documents.

`delta-wordmark-email.png` is the same mark, 400px wide, and is **not served
from here**. It is uploaded to object storage and referenced from there by
email, because a mail client cannot resolve a relative path and Outlook
renders no webp at all. It is kept in the repo so the file in storage can be
reproduced rather than being something that only exists in a bucket.

To replace it after changing the logo:

    bun apps/api/src/scripts/upload-brand-logo.ts

`delta-mark-white.png` is the "d" on its own, lifted out of the wordmark and
recoloured white for dark grounds — the login showcase chip and the app icons.
The gradient circle is left as it is, being the one piece of colour the mark
has. It was produced by cropping the wordmark to its first glyph and replacing
navy with white; nothing was redrawn.

The wordmark is navy and needs a light background. Anything on a dark ground
uses the white "d" instead.
