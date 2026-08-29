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

Both are the navy wordmark, which needs a light background. The one place it
is wrong is the decorative mark on the login showcase panel, which sits on
blue and still uses a placeholder — that needs the white variant of the logo.
