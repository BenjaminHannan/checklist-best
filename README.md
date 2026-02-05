# GreenDay Checklist

A desktop-focused MVP web app for a single student to plan daily tasks, complete habits, and keep every day green. All data is stored in a Google Spreadsheet via the Google Sheets API.

## Features
- Google OAuth sign-in with Google Identity Services
- Google Sheets as the only backend (Tasks + Settings tabs)
- Today / Upcoming / All / Completed views
- Overdue and due-today indicators
- Recurring tasks (daily or weekly) with automatic cloning on completion
- Heatmap calendar for daily completion status
- Streak counter for consecutive green days

## Local setup

### 1) Create a Google Cloud project
1. Go to **Google Cloud Console** → **Create Project**.
2. Enable **Google Sheets API**.
3. Configure the OAuth consent screen.
4. Create **OAuth Client ID** (Web application).
5. Add allowed origins:
   - `http://localhost:5173`
6. Add redirect URIs (not required for the token flow, but keep the console happy):
   - `http://localhost:5173`

### 2) Configure environment
Create a `.env` file in the project root:

```
VITE_GOOGLE_CLIENT_ID=YOUR_CLIENT_ID.apps.googleusercontent.com
```

### 3) Install and run
```
npm install
npm run dev
```

Open `http://localhost:5173`.

> Opening `index.html` directly from disk will show only a fallback message because Vite needs to
> compile the app. Always use the dev server or `npm run build` + `npm run preview`.

## First-time setup in the app
1. Click **Sign in with Google**.
2. Click **Create/Copy Template** to create a spreadsheet with the required tabs.
3. Or paste an existing Spreadsheet ID and click **Connect sheet**.

The app will ensure the spreadsheet contains:
- **Tasks** sheet with headers: `id, title, due_date, recurrence, recurrence_detail, category, completed, completed_at, created_at, updated_at, archived`
- **Settings** sheet with key/value rows.

## Recurring tasks
When a recurring task is completed, the app:
1. Marks the current task as completed.
2. Creates a **new task row** with the next due date.

This preserves history while keeping the next occurrence ready.

## Notes
- The app uses your browser timezone for due dates.
- The spreadsheet ID is stored in `localStorage` for convenience.

## Troubleshooting
- If you see authentication errors, confirm your OAuth client ID and allowed origins.
- Ensure your Google account grants access to Google Sheets and Drive file creation.
