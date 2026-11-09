<p align="center"><img src="docs/assets/icon.png" width="96" alt=""></p>
<h1 align="center">StudyPilot</h1>
<p align="center">Your Canvas courses, turned into a study coach. Free Chrome extension that works with the AI you already use.</p>
<p align="center">
  <a href="https://chromewebstore.google.com/detail/fimfldjklciihkiipnncdgkbegkkcdim">Chrome Web Store</a> ·
  <a href="https://YOUR-GITHUB-USERNAME.github.io/studypilot/">Website</a> ·
  <a href="https://YOUR-GITHUB-USERNAME.github.io/studypilot/privacy.html">Privacy</a> ·
  <a href="https://YOUR-GITHUB-USERNAME.github.io/studypilot/support.html">Support</a>
</p>

![StudyPilot](docs/assets/promo-marquee-1400x560.png)

## What it does

- **Your week at a glance:** every deadline across your courses, what changed since you last looked, and exam dates found in your syllabus and announcements.
- **Practice from your lectures:** your AI (ChatGPT, Claude, Gemini, Copilot or any other) writes questions from your slides and recordings; you take them inside StudyPilot, with math and code rendered properly.
- **Mastery and coverage:** topics and mastery levels for every lecture, spaced review, flashcards, timed exam mode and "My mistakes".
- **Exam countdown:** what the next exam covers, how ready you are, and what to do today.
- **Focus timer, search across everything, grade calculator, tidy file downloads,** and learning from graded Gradescope work.

No account, no API key, no server. See the [privacy policy](docs/privacy.html).

## Install

- **Most people:** install from the [Chrome Web Store](https://chromewebstore.google.com/detail/fimfldjklciihkiipnncdgkbegkkcdim).
- **From source:** download this repository, open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and pick the folder. Google sign-in only works in the store version (see [SETUP-GOOGLE.md](SETUP-GOOGLE.md)).

## Project layout

| Folder | What's in it |
| --- | --- |
| `background.js`, `lib/` | The service worker: Canvas, Gradescope and video readers, quizzes, search, sync, focus timer |
| `sidepanel/` | The side panel (Today, Courses, Practice, Settings) |
| `content/` | Small scripts on Canvas pages (themes, to-do lists, video speed) |
| `grades/` | The grade calculator |
| `offscreen/` | PDF reading and zip building |
| `vendor/` | Bundled libraries: [pdf.js](https://github.com/mozilla/pdf.js) and [KaTeX](https://github.com/KaTeX/KaTeX), both with their licenses |
| `docs/` | The website, privacy policy and support page (GitHub Pages) |

Version history is in [CHANGELOG.md](CHANGELOG.md).

StudyPilot is an independent project and isn't affiliated with Instructure, Gradescope, Panopto or any AI provider.
