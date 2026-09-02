# Primer

Name a subject; Primer writes an explainer on it, one section at a time, then
checks the claims and finds figures. Each person signs in and keeps their own
primers, prompt edits and settings. Model calls go through the Claude Agent SDK.

## Run it

    npm install
    npm start            # http://localhost:8787, prints the invite code

The first time someone opens it they create an account with that invite code,
then add a key in Settings: an Anthropic API key or a Claude subscription
token (from `claude setup-token`), under a name of their choosing. Which
kind it is comes from the value itself (`sk-ant-api03-…` or
`sk-ant-oat01-…`), confirmed with Anthropic. Every primer is written on the
key its writer has picked. Keys are stored encrypted, but the host can use
them; that is the trust involved. `/guide` walks a newcomer through getting
a key.

Anyone can also continue as a guest, without an account: a guest pastes a
key or links to a shared one, and it is sent with each call rather than
stored; their primers and prompt edits stay in their own browser.

A key can be shared: give it a password, and anyone with an account can link
to it by typing its name and that password, then run on it. The owner sees
what the key has been used for, summed per day at API rates. Changing the
password, or unsharing, takes the key away from everyone linked to it; they
have to link again. Nothing is read from the environment: to share your own
Claude, add its token as a shared key like anyone else.

Select a term in a primer and press Define, and a new primer defining
it is written in the background, modelled on the first paragraph of its
Wikipedia page, which the writer reads first. The words you selected
become a link to it, narrowed to the term itself once the writer has
named the concept; hover the link for a preview that updates as the
definition is written. The Definition chip on the cover writes the same
kind of primer for a typed term. The research agent can also link terms
to Wikipedia at their first mention, when its prompt asks for it (change
the last line of the Research prompt in Settings to yes).

Share on a finished primer copies a link to `/s/<id>`: the primer frozen as
it is at that moment, readable by anyone with the link, signed in or not.
Later changes never reach it; share again for a new link (an unchanged
primer gets the same one back). The Share menu lists a primer's links and
can remove them.

Everything lives in `data/` (a SQLite file and the images that were found).
Back that directory up and you have backed up Primer.

## Host it

Any machine with Node 22.13+ works: `HOST=0.0.0.0 npm start` behind your usual
reverse proxy. Or, with the Dockerfile and fly.toml here, on Fly.io:

    fly launch --no-deploy                       # keep the fly.toml it finds
    fly volumes create primer_data --size 1
    fly secrets set INVITE=a-word
    fly deploy

Then send friends the URL and the invite word.

## Environment

| variable | default | |
|---|---|---|
| `PORT` | `8787` | |
| `HOST` | `127.0.0.1` | `0.0.0.0` to accept outside connections |
| `DATA_DIR` | `./data` | database and media |
| `INVITE` | generated once | needed to create an account |
| `PRIMER_SECRET` | generated once | encrypts stored keys and tokens |
