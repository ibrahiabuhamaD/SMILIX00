# SMILIX

An Arabic, RTL dental booking site with a Node.js API, SQLite storage, patient accounts, an admin dashboard, and optional WhatsApp Business notifications.

## Run locally

1. Install Node.js 22.13 or newer (SQLite is built in; no native build tools are needed).
2. Edit the root `1.env` file and replace `SESSION_SECRET` with a long random value. The server falls back to `.env` if `1.env` is absent. The requested admin email/password are supplied as local first-run defaults; change them before exposing the site publicly.
3. Run `npm install`, then `npm start`.
4. Open `http://localhost:3000`.

SQLite data is stored in `data/smilix.sqlite`. Do not delete this file if you want to keep bookings and accounts.

## Deploy the shared server

GitHub Pages can host the static files but cannot run this Node.js API or SQLite database. To make bookings shared across users, push this project to a GitHub repository, create a Render Blueprint from that repository, and let Render use the root `render.yaml` file. Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` when prompted. Render generates `SESSION_SECRET`; the SQLite database is stored on the configured persistent disk. A paid Render web-service plan is required for the persistent disk.

After deployment, open the generated Render URL. The app detects the hosted API automatically. Set `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` in the Render service environment to enable WhatsApp Business API notifications; without them, the booking still saves and opens a prefilled WhatsApp message.

## Open without a server

Open `public/index.html` directly. The standalone mode stores accounts, settings, and bookings in this browser's local storage; passwords are PBKDF2-hashed. Appointment times are shown in 12-hour Arabic format. The local admin starts with `ibr.jx@gmail.com` / `ibrjX1` and can change the password in the admin panel.

Standalone data stays in this browser profile on this device and is not shared with other devices or browsers. WhatsApp opens with a prefilled message for the user to send; automatic WhatsApp notifications and reminders require the Node.js service and WhatsApp Business API configuration.

## WhatsApp setup

Automatic notifications and one-hour reminders require a Meta WhatsApp Business Cloud API phone-number ID, access token, and approved Arabic message templates. Set `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, and the two template names in `.env`. The booking template body should accept five text parameters in this order: patient name, date, time, service, phone. The reminder template accepts four: patient name, date, time, service. The business recipient uses international digits without a leading `+`.

Without those credentials, appointments are still safely stored and the confirmation page offers a prefilled WhatsApp link to the clinic. The browser cannot send WhatsApp messages in the background by itself.

## Before public deployment

Change the initial admin password and session secret; use HTTPS, back up the SQLite file, and configure the WhatsApp Business templates and credentials. The one-hour reminder scheduler runs while this Node process is online. Use a process manager or hosting scheduler that keeps the service running continuously.