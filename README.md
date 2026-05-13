# DOF Studios

Static frontend split from the original single-page file so it is easier to edit and connect to a backend later.

## Project Structure

```text
.
├── index.html
├── homepage.html
├── explore.html
├── photographerdashboard.html
├── publicprofile.html
├── assets
│   ├── css
│   │   └── styles.css
│   ├── images
│   │   └── .gitkeep
│   └── js
│       ├── app.js
│       └── tailwind.config.js
└── backend
    └── README.md
```

## Frontend

- `index.html` is kept as the default homepage entry for static hosts.
- `homepage.html` contains the landing page.
- `explore.html` contains the photographer browsing page.
- `photographerdashboard.html` contains the photographer dashboard shell.
- `publicprofile.html` contains the public photographer profile shell.
- `assets/css/styles.css` contains all custom styles from the original page.
- `assets/js/tailwind.config.js` contains the Tailwind CDN config.
- `assets/js/app.js` contains shared frontend behavior, page routing, mock app data, and temporary session persistence between pages.
- `assets/images/` is reserved for local image files when you start replacing remote images or data URLs.

## Backend

The backend is scaffolded as Vercel serverless Node API routes with Supabase.

- `api/[...path].js` contains the catch-all API route.
- `backend/lib/` contains backend helpers.
- `backend/supabase/migrations/001_initial_schema.sql` contains the initial Supabase schema.
- `backend/docs/setup.md` explains environment variables and deployment.
- `backend/docs/api.md` lists the first API endpoints.

The frontend now uses `/api/...` for the main backend flows while preserving the existing UI. Some demo fallback data remains so pages can still render before Supabase is configured.
