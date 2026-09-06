const express = require('express');
const cors = require('cors');
const uploadRouter = require('./routes/upload');
const authRouter = require('./routes/auth');
const jiraRouter = require('./routes/jira');

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api', uploadRouter);
app.use('/api/auth', authRouter);
app.use('/api/jira', jiraRouter);

// Vercel imports this file as a serverless function and calls the exported
// app directly, so app.listen() must only run for local/standalone use.
if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
