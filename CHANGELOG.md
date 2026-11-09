# StudyPilot changelog

A Chrome extension that makes Canvas friendlier and turns your course material into practice. It reads your own Canvas data (courses, lectures, files, grades and deadlines). It works with **any AI you already use** by copy and paste, so there's no API key, no account and nothing to pay for.

## New in 5.6
- **No false "Overdue" for Gradescope work.** With Gradescope connected, StudyPilot checks what you turned in there. Without it, past-due Gradescope work shows "Turned in on Gradescope?" and paper work shows "Past due".
- **Math and code in quizzes.** LaTeX (`$x^2$`, `$$\sum x_i$$`) is drawn with KaTeX (bundled); code shows in code blocks. Backslashes the AI forgets to escape are repaired.
- **Shuffled every time.** Question order and answer options change on every take ("All of the above" stays last).
- **Mastery levels and topic coverage.** Each lecture remembers its topics; the action sheet shows "8 of 11 covered", a level per topic (New, Learning, Familiar, Mastered), "Quiz me on the missing topics" and "Practice weak topics".
- **My mistakes.** Missed questions come back until you get each right twice in a row.
- **What changed.** Today lists due dates that moved, new work, new grades and exam date changes. Optional notifications for the important ones.
- **Focus timer.** Just 5 minutes, 15+5, 25+5, 50+10 or custom; runs in the background with the minutes left on the toolbar icon; time is logged per course (Practice › Focus time this week).
- **Exam countdown.** For the next exam within two weeks: what it covers (lectures since the last exam), how ready you are, and today's steps (fill gaps, review, weak topics; timed practice exams in the last two days).
- **Search everything** (the magnifier, or press /): slides by page, recordings by time (Panopto links jump to that moment), assignments, announcements, syllabi, exams and your questions. "Ask my AI using these results" sends the top excerpts.

## The side panel: Today · Courses · Practice · Settings

### New in 5.5
- **Video speed:** a small control on lecture videos (Canvas, Canvas Studio, your Panopto site, and optionally YouTube/Kaltura): − / + buttons, a slider, or type a speed (0.25–4×). Keys: S slower, D faster, R reset. The same speed is set from StudyPilot (Settings › Canvas pages, or a course's Lecture videos). It only changes playback speed; nothing is skipped.
- **Lecture video downloads:** transcripts as a zip of text files, or the video files themselves (only where the instructor allows downloads; saved as video files, not zipped). In Back up everything, transcripts and video files are separate boxes (video files off by default).
- **Size check:** any download over 200 MB says how big it is and asks first.

### New in 5.4
- **Exam dates** found automatically: exam-named assignments and calendar events in Canvas, announcements (newest first, so a moved exam is caught), and the syllabus, syllabus files and schedule pages. Shown on Today ("Exams coming up"), each course's Overview (fix or add any), Practice › Exam prep, and used by Plan my week.
- **Lecture videos:** connect your school's Panopto site once (Settings › Connections › Lecture videos; "Find it" detects it from your courses). Each course's Lectures page lists its recordings; StudyPilot reads the captions, so recordings get quizzes, flashcards and study guides like slides. Videos uploaded into Canvas pages have their captions added to that page's text automatically.
- **Sign in with Google:** syncs quizzes, progress, grade calculators, exam fixes and settings between computers through a private app folder in your own Google Drive. See SETUP-GOOGLE.md.

### Today
- What's overdue, due today and due this week, plus a "Next up" list with course colors.
- **Review**: the practice questions due today, one tap to start.
- **Plan my week**: your AI builds a schedule from your deadlines, grades and busy times. Copy its reply and come back; the sessions appear here. Add them to Google Calendar, or download a calendar file for any app.
- **Explain this page**: sends the Canvas page you're on to your AI.
- **Deadlines → calendar**.

### Courses
Each course has four pages:
- **Overview**: practice progress, what's coming up, announcements and recent grades. **Study guide** sends the course (syllabus, assignments, modules, announcements) to your AI.
- **Lectures**: every lecture page and slide deck, newest first, grouped by module. Filters are New for me, Lectures and Everything. Each lecture shows how much of it you've mastered. Tap a lecture or a module to open the action sheet.
- **Grades**: your Grade Ledger, filled in automatically. Canvas category weights are used when the course has them. Otherwise StudyPilot reads the syllabus: the Syllabus page, files and pages linked from it (PDF or Word), syllabus items in modules (or anything in a "Syllabus"/"Start here" module), then Pages and Files. If none of those give a breakdown, **Read the weights with my AI** sends the syllabus to your AI and fills in its answer. Edit anything for what-ifs; your edits are kept per course until **Reload from Canvas**. The final-exam calculator starts from your current score.
- **Files**: course files and your own submissions as one zip per course, your **Gradescope** work (graded copies with marks and comments when they're ready, otherwise what you turned in), an option to keep lecture slides in Downloads, Jupyter notebooks for that course, and a pack for an AI project.

### The action sheet (same everywhere)
- **Quizzes**: **Make a quiz** opens your AI with the lecture and the request already in the chat box (slides attached when they're needed). Press Send, copy the reply and come back. It becomes **Quiz 1**, the next one **Quiz 2**, and so on, each listed under the lecture with your best score. Retake any quiz; new quizzes avoid repeating earlier questions. **Mixed practice** draws from all of a lecture's questions, weakest first, and **Exam mode** gives a timed mix with answers at the end.
- **Flashcards**: key terms pulled from the lecture text with no AI needed, plus your practice questions.
- **Study guide**: a summary, key ideas and examples in your AI. **Quiz me in the chat** is the conversational version, which isn't tracked.
- **Download**: the slides and images as one zip.

Handwritten or scanned slides are attached automatically. When a lecture has diagrams, StudyPilot offers to send the slides as well.

### Practice
- **Today's review**: spaced repetition with Leitner boxes. Questions come back after 1, 3, 7, 16 and 35 days, and missed ones come back in 10 minutes.
- **Exam prep**: pick a course, the units and how many questions, with an optional timer.
- **Weak spots**: topics under 70% right, with one tap to practice them.
- **Progress** per course and your recent sessions.
- **Add questions you got elsewhere**: paste a reply from an AI on your phone.

Question types are multiple choice, true/false, short answer (you grade yourself against a model answer, with a suggestion) and flashcards. Keyboard shortcuts: A–F or 1–6 to answer, T/F, Space to flip, Enter for next, 1/2/3 to grade and Esc to close.

### Settings (grouped)
- **Your AI**: ChatGPT, Claude, Gemini, Copilot, another AI (name and address), or "just copy". You can also choose whether replies are picked up from the clipboard automatically.
- **Appearance**: course card style, size slider and minimal cards; the theme for Canvas and StudyPilot (Default, Glass, Glass Dark, Dark, Midnight, Dim and Paper; pictures keep their real colors), accent, nav bar, card style, course colors, font, text size, an easy-to-read font, high contrast and reduced motion.
- **Canvas pages**: Due soon list, Announcements in place of To Do, Recent grades in place of Recent Feedback, card badges and Practice buttons.
- **Study & quizzes**: questions per request, difficulty, and your study hours for plans.
- **Connections**: Canvas, calendar (a private iCal link or Google Calendar) and JupyterHub.
- **Courses**: only favorites, and which courses to hide.
- **Data & privacy**: background lecture prep, **Back up everything**, course text for your AI (with "only what's new") and AI project packs, question bank backup and restore, and clearing data.

### Back up everything
One zip for the courses you pick; Chrome asks where to save it. Inside, each course has:
- `Modules/01 <module>/01 <section>/…`: every file, page (.html), assignment and discussion in module order, split by the module's text headers, plus `Links.md` for web links.
- `Files/<Canvas folders>/…`: course files that aren't in a module.
- `Pages/`, `Assignments/`, `Discussions/`: anything not in a module.
- `Syllabus.html`, `Announcements.html`, `My grades.csv`.
- `My submissions/<assignment>/…`: your uploaded files and typed answers, plus `My submissions/Gradescope/…` when Gradescope is connected.
- `_Not included.txt`: quizzes, outside tools and locked items, which are never opened.

## How "any AI" works
1. StudyPilot opens your AI in a new tab and fills in the chat box with the request and any slides (Claude, ChatGPT, Gemini and Copilot; it asks once for access to that site). It never presses Send. For other AIs, or if filling in fails, the request is on your clipboard and the slides are in one folder.
2. You check it and press Send.
3. For questions and plans, the AI ends its reply with a small code block (`studypilot-quiz` or `studypilot-plan`). Copy the whole reply and switch back. StudyPilot reads the clipboard (only while it's waiting for a reply), or you can press **Paste reply**.

Nothing is sent anywhere by StudyPilot itself.

## On Canvas pages
These can be turned off in Settings › Canvas pages:
- Due soon list, Announcements and Recent grades cards with full-screen views.
- Grade and due-this-week chips on course cards.
- **Practice** buttons on lecture pages, slides and module headers, which open the action sheet in the side panel.
- Your theme and colors.

## Safety: what StudyPilot never touches
- Canvas is only ever **read** (GET requests). Nothing is submitted, posted or marked.
- **Quizzes, tests, exams and external tools** are never opened or fetched. Only their names and due dates appear, and the extension doesn't run on those pages.
- Locked and hidden items are skipped.
- Reading a course file through Canvas can count as "viewed" for module progress, the same as opening it yourself.

## Install
1. Unzip into a folder.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the folder that contains `manifest.json`.
4. Click the StudyPilot toolbar icon. Connect Canvas, then choose your AI.

Your data stays in this browser, including practice questions, progress and your grade calculator. Use Settings › Data & privacy › Save backup to move your questions to another computer.

## Gradescope
Connect it once (a course's Files page or Settings › Connections) and log in to gradescope.com with your school account. StudyPilot matches Gradescope courses to Canvas courses by name (you can change the match) and reads only through your own login. It only downloads submissions that exist; it never opens assignments you haven't submitted (opening a timed one can start its timer) and never submits anything. Gradescope has no public student API, so a change to their site can break this until StudyPilot is updated.

## Permissions
- Notifications (optional, asked only if you turn on alerts or timer notifications).
- Access to your AI's site (asked once, only for the AI you pick): fills in the chat box. Turn it off with Settings › Your AI › Fill it in for me.
- `clipboardRead` (new in v5): picks up your AI's reply when you come back to the panel. It only reads while a reply is expected, and you can turn it off.
- `offscreen`, `unlimitedStorage`: reading PDFs and slides, the lecture library and the question bank.
- `downloads`: zips in Downloads › StudyPilot.
- `identity`: optional Google Calendar sign-in.
- Optional site access, asked for when needed: your Canvas address if it isn't on instructure.com, Canvas's file storage, your calendar link and your JupyterHub.

## Google Calendar setup (optional, one time)
You don't need this. Plans and deadlines can also go into any calendar app as a file. For one-click adding:
1. In Google Cloud Console, create a project and enable the **Google Calendar API**.
2. Under **OAuth consent screen**, choose External, add the scopes `calendar.events` and `calendar.readonly`, and add yourself as a test user.
3. Under **Credentials → Create OAuth client ID**, choose **Chrome Extension** and paste your extension ID.
4. Put the client ID in `manifest.json` under `oauth2.client_id` and reload.

A Chrome Extension client ID isn't a secret and has no secret attached. It only works for the extension ID it was made for.

## Files
```
manifest.json            MV3
background.js            Sync, lectures, library, zips, grades data, Jupyter, calendar, badge
lib/canvas.js            Read-only Canvas API client
lib/safety.js            What's never opened (quizzes, tools, locked items)
lib/ai.js                "Your AI": providers, question requests, reading replies
lib/quiz.js              Question bank and named quizzes (IndexedDB), spaced review, sessions, auto flashcards
lib/autofill.js          Fills in the AI's chat box (never sends)
lib/exams.js             Exam dates from Canvas, announcements and syllabus text
lib/videos.js            Lecture video captions (Canvas media, Panopto)
lib/gradescope.js        Gradescope submissions and graded copies
lib/sync.js              Google sign-in and Drive app-folder sync (merge rules)
docs/privacy.html        Privacy policy, ready for GitHub Pages
SETUP-GOOGLE.md          Google sign-in setup, step by step
lib/grades.js            Canvas/syllabus weights → Grade Ledger rows
lib/packs.js             Study guides, plans, exports (Markdown for any AI)
lib/planparse.js         Reads a plan reply
lib/ics.js               Calendar files (deadlines, study sessions)
lib/jupyter*.js          JupyterHub access and notebook → Markdown
lib/extract.js           PDF/PPTX/DOCX reading, diagram and handwriting detection
lib/library.js           Lecture library (IndexedDB)
lib/look.js, icons.js    Themes and icons
grades/                  Grade Ledger (unchanged) + StudyPilot storage adapter and host
content/                 Canvas page features and theme
sidepanel/               main.js, core.js, aiflow.js, sheet.js, runner.js, views/
offscreen/, vendor/pdfjs Hidden file reader (pdf.js 4.10.38, Apache-2.0)
```
