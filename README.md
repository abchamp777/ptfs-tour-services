# PTFS Tour Services

A polished public/private PTFS tour website with a Discord-first workflow, password-protected Operations Center, mileage rewards, membership benefits, public-tour capacity limits, waitlists, and online check-in.

## Features

- Public tour board
- Public tour booking with automatic capacity enforcement
- Automatic waitlist when a public tour is full
- Private tour requests
- Standard private requests use the waitlist
- Priority membership: 1,500 miles, private requests without the waitlist
- Executive membership: 3,000 miles, private flights without the waitlist + premium meals
- Mileage rewards: 100–700 miles for each completed flight, awarded once per booking
- Mileage lookup and redemption page
- Online check-in using confirmation code + Roblox username
- CEO / Chair password-protected Operations Center
- Schedule and manage public/private tours
- Review and manage bookings
- Complete a booking to automatically award mileage
- Review mileage accounts in Operations
- Discord-ready tour announcement generator
- One-click copy buttons for Discord announcements and booking confirmations
- PTFS airport/airfield choices in the public booking form
- Local JSON storage for easy testing
- PostgreSQL support for production persistence
- Supplied PTFS Tour Services logo displayed only in the top-left site header
- No other website photos/images
- Responsive aviation-themed UI

## Run locally

1. Install Node.js 20+.
2. Open this folder in VS Code.
3. Run:

```powershell
npm install
```

4. Copy `.env.example` to `.env`.
5. Set `OPERATIONS_PASSWORD` and `SESSION_SECRET`.
6. Start:

```powershell
npm start
```

7. Open `http://localhost:3000`.
8. Operations: `http://localhost:3000/operations`

## Production / Render

Set these environment variables in your hosting provider:

- `OPERATIONS_PASSWORD` = your private operations password
- `SESSION_SECRET` = a long random secret
- `DATABASE_URL` = your PostgreSQL connection string
- `DISCORD_INVITE` = `https://discord.gg/EH7F5WnwKH`
- `SITE_URL` = your deployed site URL

The app automatically creates and migrates the required PostgreSQL tables on startup when `DATABASE_URL` is present.

## Mileage system

Mileage is tied to the Discord + Roblox username pair used for bookings.

- Every booking marked `Completed` awards a random **100–700 miles** exactly once.
- **Priority:** 1,500 miles. Allows private requests without the standard private-tour waitlist.
- **Executive:** 3,000 miles. Allows private requests without the waitlist and automatically provides premium meal service on eligible private flights.

For production, the Operations team should confirm bookings and mark them `Completed` after the flight. That completion event is what awards the mileage.

## Public tour capacity

When a passenger requests a public tour, the server checks the tour's capacity before accepting the request.

- If seats are available, the request starts as `Pending`.
- If the tour is full, the request starts as `Waitlisted`.
- When a confirmed/pending booking is declined, the system automatically promotes the earliest waitlisted requests that fit into the newly available capacity.

## Online check-in

A confirmed or boarding passenger can use the public **Online Check-In** section with:

- Confirmation code
- Roblox username

The server verifies the booking before recording the check-in timestamp.

## Discord-first workflow

When the CEO / Chair creates a tour in Operations, the site produces a block of Discord Markdown. Click **Copy Discord Announcement**, then paste it directly into Discord. No reformatting is required.

The public tour cards also have **Copy for Discord**, so scheduled tours can be reposted quickly.

## Final theme + member controls

- Default theme is **Black & Blue**.
- Visitors can switch between **Black & Blue**, **Black & Grey**, **White & Black**, and **White & Blue** from the Theme selector. The selection is saved in the browser.
- Operations Center includes **Reset Miles** for zeroing a member's mileage and clearing that member's mileage transaction history.
- Operations Center includes **Delete User + Miles**, which permanently removes the selected mileage member, their mileage transaction history, and matching booking records. A confirmation prompt is shown before deletion.
