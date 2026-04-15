// scripts/test-rag.js
//
// Quick local smoke-test of the RAG pipeline without starting the
// web server. Imports rag.js directly and prints the answer.
//
// Usage:
//   node scripts/test-rag.js
//   node scripts/test-rag.js "your question here"

import 'dotenv/config';
import { answerQuestion } from '../src/rag.js';

const question =
  process.argv[2] || '사업자등록을 하려면 어떤 절차와 서류가 필요한가요?';

console.log(`\nQ: ${question}\n`);

try {
  const answer = await answerQuestion(question);
  console.log(`A: ${answer}\n`);
} catch (err) {
  console.error('FAILED:', err);
  process.exit(1);
}
