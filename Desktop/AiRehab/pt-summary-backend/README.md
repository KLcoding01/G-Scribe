# Kelvin PT Note Bot (Note Reviser)

A local web app that revises PT notes **only** per the user’s requested changes, using your formatting rules:

- Pre-summary status line (no "Subjective" label)
- Main summary = **5–7 sentences**
- No "Pt reports / Pt states / verbalizes" inside main summary (those belong only in the pre-summary line)
- No arrow symbols (↑ ↓)
- Main summary final sentence supports continued skilled PT
- Final separate line starts with **PT POC:** and states plan of care

## Quick start

1) Install Node.js (v18+)
2) Download/unzip this project
3) In the project folder:

```bash
npm install
cp .env.example .env
# edit .env and set OPENAI_API_KEY
npm start
```

4) Open: http://localhost:3300

## API

POST `/api/revise-note`

```json
{
  "originalNote": "text...",
  "changes": "text...",
  "sentenceTarget": 6
}
```

Returns:

```json
{ "output": "revised note text..." }
```

## Notes

- The validator will automatically run a **single correction pass** if the first output violates rules.
- This project avoids storing notes; it does not persist data to disk.
