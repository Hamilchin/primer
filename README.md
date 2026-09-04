# Primer

Name a subject; Primer writes an explainer on it, one section at a time, and
finds figures. Research, off unless turned on in Settings or run from the foot
of a primer, then checks the claims against the web. Each person signs in and keeps their own
primers, prompt edits and settings.

## Run it

    npm install
    npm start            # http://localhost:8787, prints the invite code

The first time someone opens it they create an account with that invite code,
then add a key in Settings, under a name of their choosing: a Claude
subscription token (from `claude setup-token`), or an Anthropic, OpenRouter
or OpenAI key. Which kind it is comes from the value itself, confirmed with
its provider. Every primer is written on the key its writer has picked. Keys
are stored encrypted, but the host can use them; that is the trust involved.
`/guide` walks a newcomer through getting a key.

A subscription's calls run through Claude Code, by way of the Claude Agent
SDK, since only Claude Code may spend one. Every other key is spoken to
directly, through the Vercel AI SDK. The tools are the same either way: one
web search for everyone (Brave, with `BRAVE_SEARCH_KEY`; without it the
agents can read pages but not search), a page reader, and the finder's eyes.
Each agent runs on a Claude model by default; under Models in Settings it
can be put on another from the catalogue in `agents.mjs`, as far as the key
in use can run it. An OpenAI key, which runs no Claude model, runs GPT-5.6
Terra where nothing is chosen. The owner of a key sees what it has been
used for by day, and what is left on it where the provider will say:
OpenRouter's credit, a subscription's usage windows.

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

A section can have subsections, numbered 3.1, 3.2 in the margin and listed
under their section in the contents. The planner divides a section only
when it would run long and fall into distinct parts, the writer follows
that plan, and a revision can open a subsection when what it adds is too
large for a paragraph. Most primers have none.

Share on a finished primer offers two kinds of link to `/s/<id>`, readable
by anyone, signed in or not. The public link follows the primer: readers
see it as it stands and as it changes, and while it is still being written
their page brings each new piece in. Turning the switch off takes the link
back. A frozen link is a copy of the primer as it is that moment; later
changes never reach it, and the Share menu lists those copies and can
remove them.

Feedback in the top bar, and Complain in the pen, send a reader's words to
whoever hosts, along with the page they were on. The account named by
`ADMIN` reads them on the Feedback page of Settings; with `ADMIN` unset,
the first account made is the host.

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
| `ADMIN` | the first account | account names, comma-separated, that read feedback |
| `BRAVE_SEARCH_KEY` | unset | the web search every agent uses, from brave.com/search/api |
