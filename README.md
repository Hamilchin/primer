# Primer

Name a subject and Primer writes an explainer on it: a plan, then sections
one at a time, with diagrams and images where they help. Research, when
turned on, checks the claims against the web and cites or corrects them.

Select a passage and a pen appears: ask for an example, a diagram, a
definition, or anything in your own words, and the primer is revised in
place. Undo takes a revision back whole.

Each primer has its own address. Make it public and anyone with the link can
read it, as it is written and as it changes. A frozen link keeps a copy as
it stands.

Primer runs on your own key: a Claude subscription, or an Anthropic,
OpenRouter or OpenAI key, added in Settings. A key can be shared with a
password, and its owner sees what it has been used for. There are no keys
in the environment.

Accounts need an invite code. Guests can use it without one, with a key
they paste; their primers stay in their browser.

## Run it

    npm install
    npm start            # http://localhost:8787, prints the invite code

Needs Node 22.13+. Everything is kept in `data/`; back that up and you have
backed up Primer.

## Host it

`HOST=0.0.0.0 npm start` behind a reverse proxy, or on Fly.io with the
Dockerfile and fly.toml here:

    fly launch --no-deploy
    fly volumes create primer_data --size 1
    fly secrets set INVITE=a-word PRIMER_SECRET=$(openssl rand -hex 32)
    fly deploy

Set `PRIMER_SECRET` from the start: it encrypts the stored keys.

| variable | default | |
|---|---|---|
| `PORT` | `8787` | |
| `HOST` | `127.0.0.1` | `0.0.0.0` to accept outside connections |
| `DATA_DIR` | `./data` | database and images |
| `INVITE` | generated once | needed to create an account |
| `PRIMER_SECRET` | generated once | encrypts stored keys; set it in production |
| `ADMIN` | the first account | accounts that read feedback, comma-separated |
