# Working on this deck

This folder is a DeckWerk presentation. You make a slide by writing an
ordinary HTML page and importing it; DeckWerk turns what the browser draws
into editable slide objects. Don't read or edit `deck.json`.

## CLI
{{LAUNCHER_HINT}}
## 1. Look at the slides around yours

    slide-agent render . --slide 8,9,10 --output /tmp/ctx     # PNGs
    slide-agent inspect . --html-body --slide 8,9,10          # their markup

Slides are numbered as in the editor's rail. Match the neighbours by using
the same layouts and text roles they use, not by copying their fonts or sizes.
`slide-agent comments . --unresolved` shows requests people left on slides.

## Use the deck's layouts and text roles first

A layout places the boxes and the theme styles them, so slides built from
them follow every later design change. Put `data-layout="standard"`, `"title"`
or one of the deck's own on the `<section>` (`style.layouts` in `slide-agent
context .` lists them and their slots) and `data-layout-slot` (`title`,
`subtitle`, `body`, `body-2`…, `caption`) on its boxes; write the words and
leave position and type to DeckWerk. Add a box of your own only when no slot
fits, with class `role-title`, `role-heading`, `role-body` or `role-caption`
and no font, size or colour of its own: apply's `warnings` and `themeDrift` in
`slide-agent validate .` list text that does not follow the theme. To change
the look, change the theme, not the slide: `slide-agent theme list .`, then
`slide-agent theme apply . --id <id> --scope deck`.

## 2. Write your slide as a normal web page

Create `drafts/slide.html` — not in `edit/`, which the editor watches:

    <!doctype html>
    <html><head>
    <base href="../">
    <link rel="stylesheet" href="theme.css">
    <style> /* your CSS */ </style>
    </head><body>
    <section class="slide" data-layout="standard" style="width:1920px;height:1080px;position:relative;overflow:hidden">
      <h1 data-layout-slot="title">…</h1>
      <div data-layout-slot="body">…</div>
    </section>
    </body></html>

Beside the slots, use any HTML and CSS: flex/grid, `<img>`, `object-fit`,
`border-radius`, gradients, SVG. Put images in `assets/` (or run
`slide-agent asset import . <file>`) and refer to them as `assets/<name>`.
Iterate in a browser, e.g. `chromium --headless --screenshot=/tmp/s.png
--window-size=1920,1080 drafts/slide.html`. Nothing here involves DeckWerk.

For JavaScript (a live chart, a demo) write a self-contained page, then
`slide-agent web add . chart.html --size 1680x620` and paste the printed
`<div data-element="web" …>` beside a normal title; no network on stage.
A data chart: paste the editable plot `slide-agent plot . spec.json` prints.

## 3. Put it in the deck

    slide-agent apply . --html drafts/slide.html --after 8    # insert after slide 8
    slide-agent apply . --html drafts/slide.html              # append

The first apply stamps `data-slide-id` into your file; applying it again
replaces that slide, so start each *new* slide from a fresh file. To **replace an existing slide** with your page, copy
its id (from `inspect --html-body`) onto your `<section>` before applying.
To delete or reorder slides, `slide-agent inspect . --html --slide 8,9 >
edit/work.html`, then remove or reorder the `<section>`s there and save.

Check apply's `changes`: a `deleted` you did not intend means undo in the editor.

## 4. Check and iterate

    slide-agent render . --slide 9 --output /tmp/final

Compare that with your browser screenshot. If something is off, fix your HTML
and apply again. If DeckWerk draws valid HTML/CSS differently from the
browser, that is a DeckWerk bug: say so rather than working around it.

## About this file

DeckWerk regenerates this `AGENTS.md` when the deck opens. Delete the
generated marker on its first line to keep a custom copy. Longer references,
if you ever need them: `slide-agent docs`.
