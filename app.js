// Import necessary Node.js modules
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

// IMPORTANT: Replace with your actual Gemini API Key.
// In a real application, you'd load this from environment variables (e.g., process.env.GEMINI_API_KEY)
// for security. For this example, you can paste it directly, but be careful not to commit it to public repos.
const API_KEY = "AIzaSyDgO3Z8BFghpvH3GvJhxhK2_RSNYxb6J70";

// Function to read all Markdown files from a directory and its subdirectories
async function readMarkdownFiles(dir) {
    let markdownContent = '';
    const files = await fs.promises.readdir(dir, { withFileTypes: true });

    for (const file of files) {
        const fullPath = path.join(dir, file.name);
        if (file.isDirectory()) {
            // Recursively read from subdirectories
            markdownContent += await readMarkdownFiles(fullPath);
        } else if (file.isFile() && file.name.endsWith('.md')) {
            // Read the content of Markdown files
            console.log(`Reading Markdown file: ${fullPath}`);
            const content = await fs.promises.readFile(fullPath, 'utf8');
            markdownContent += `\n--- FILE: ${file.name} ---\n${content}\n`;
        }
    }
    return markdownContent;
}

// Function to read questions from a CSV file
function readQuestionsFromCsv(filePath) {
    return new Promise((resolve, reject) => {
        const questions = [];
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (row) => {
                // Assuming the first column of your CSV contains the question
                // You might need to adjust 'Object.values(row)[0]' if your CSV has headers
                // and you know the header name (e.g., row.Question)
                questions.push(Object.values(row)[0]);
            })
            .on('end', () => {
                console.log('Finished reading questions from CSV.');
                resolve(questions);
            })
            .on('error', (error) => {
                reject(error);
            });
    });
}

// Function to call the Gemini API for generating answers
async function getAnswerFromGemini(question, context) {
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`;

    const prompt = `En vous basant sur le contenu du document suivant, répondez à la question avec précision et concision. Si l'information n'est pas explicitement fournie, indiquez que vous ne trouvez pas la réponse dans le contexte fourni.\n\nContenu du document :\n${context}\n\nQuestion : ${question}\n\nRéponse :`;

    const chatHistory = [];
    chatHistory.push({ role: "user", parts: [{ text: prompt }] });

    const payload = { contents: chatHistory };

    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Gemini API error: ${response.status} - ${errorBody}`);
        }

        const result = await response.json();
        if (result.candidates && result.candidates.length > 0 &&
            result.candidates[0].content && result.candidates[0].content.parts &&
            result.candidates[0].content.parts.length > 0) {
            return result.candidates[0].content.parts[0].text;
        } else {
            console.warn("Unexpected Gemini API response structure:", JSON.stringify(result, null, 2));
            return "Could not generate an answer. Unexpected API response.";
        }
    } catch (error) {
        console.error("Error calling Gemini API:", error);
        return `Failed to get an answer from the AI: ${error.message}`;
    }
}

// Main function to run the QA process
async function main() {
    const markdownDirPath = path.join(__dirname, 'markdown_docs');
    const questionsCsvPath = path.join(__dirname, 'questions.csv');

    try {
        // Read all Markdown content
        console.log(`Reading Markdown files from: ${markdownDirPath}`);
        const allMarkdownContent = await readMarkdownFiles(markdownDirPath);
        if (!allMarkdownContent.trim()) {
            console.warn("No Markdown content found. Please ensure 'markdown_docs' directory exists and contains .md files.");
            return;
        }

        // Read questions
        console.log(`Reading questions from: ${questionsCsvPath}`);
        const questions = await readQuestionsFromCsv(questionsCsvPath);
        if (questions.length === 0) {
            console.warn("No questions found in 'questions.csv'. Please ensure it's correctly formatted.");
            return;
        }

        console.log('\n--- Processing Questions ---');
        for (const question of questions) {
            console.log(`\nQuestion: ${question}`);
            // This is the "RAG-like" part: sending the question + ALL markdown content to the LLM.
            // For very large content, you might need to implement more sophisticated chunking
            // and retrieval logic to fit within token limits, or use an embedding model.
            const answer = await getAnswerFromGemini(question, allMarkdownContent);
            console.log(`Answer: ${answer}`);
            console.log('----------------------------');
        }

    } catch (error) {
        console.error('An error occurred:', error);
    }
}

// Run the main function
main();
