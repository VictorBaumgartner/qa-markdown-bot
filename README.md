# 📄 Gemini QA Processor - Node.js

A simple Node.js script that reads Markdown files from a directory, extracts their content, reads questions from a CSV file, and queries Google Gemini API to generate answers based on the Markdown context.

---

## ✨ Features

* Recursively reads `.md` files from a specified directory.
* Reads questions from a CSV file.
* Sends combined Markdown content and each question to Google Gemini (via API).
* Logs the generated answers.

---

## 🚀 Requirements

* **Node.js 18+**

Install required packages:

```bash
npm install csv-parser
```

---

## 🔧 Setup

1. **Clone or download** this project.
2. Place your Markdown files into the `markdown_docs/` directory.
3. Place your CSV file named `questions.csv` in the root directory. Each row should contain one question.
4. Update your **Google Gemini API Key** in the script:

```javascript
const API_KEY = "YOUR_API_KEY_HERE";
```

*(Important: Keep this key secure. Do NOT commit to public repositories.)*

---

## ▶️ Running the Script

Execute the script using Node.js:

```bash
node your_script_name.js
```

---

## 📂 Directory Structure

```
.
├── your_script_name.js  # Main script file
├── markdown_docs/       # Folder containing .md files
│   ├── file1.md
│   └── ...
└── questions.csv        # CSV file containing questions
```

---

## ❗ Notes

* The script sends **all Markdown content as context** to Gemini for each question. For large datasets, consider chunking the content.
* CSV is expected to have questions in the **first column**.

---

## 🔒 Security Warning

* Your **Gemini API Key is hardcoded** for simplicity. In production, use environment variables (`process.env`).

---

## 📜 License

MIT License.

---

## 🤝 Contributions

Suggestions and improvements are welcome! Open an issue or pull request.
