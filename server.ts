import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import multer from 'multer';
import { AssemblyAI } from 'assemblyai';
import fs from 'fs';
import dotenv from 'dotenv';

import os from 'os';

dotenv.config();

const app = express();
const PORT = 3000;

const uploadDir = path.join(os.tmpdir(), 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure Multer for file uploads
const upload = multer({ 
  dest: uploadDir,
  limits: { fileSize: 200 * 1024 * 1024 } // 200MB limit
});

// Initialize AssemblyAI
const client = new AssemblyAI({
  apiKey: 'a21a8eb91b4a484a831c91cab53e99a5',
});

async function startServer() {
  app.use(express.json());

  // API Endpoint to upload a file to temp storage
  app.post('/api/upload', upload.single('audio'), (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No audio file uploaded' });
      }
      
      const fileId = req.file.filename; // Multer generates a unique filename
      console.log('File successfully saved to temp storage:', fileId);
      
      res.json({ fileId, fileName: req.file.originalname });
    } catch (error: any) {
      console.error('Upload error:', error);
      res.status(500).json({ error: error.message || 'Internal server error' });
    }
  });

  // API Endpoint to start transcription from temp storage
  app.post('/api/transcribe', async (req, res) => {
    try {
      const { fileId, fileName } = req.body;
      
      if (!fileId) {
        return res.status(400).json({ error: 'No fileId provided' });
      }

      const filePath = path.join(uploadDir, fileId);
      if (!fs.existsSync(filePath)) {
         return res.status(404).json({ error: 'File not found on server' });
      }

      console.log('Starting transcription for:', fileName, 'using temp file:', fileId);

      try {
        console.log('Submitting to AssemblyAI...');
        let transcript;
        let submitRetries = 3;
        let modelToUse = 'universal-2';
        
        while (submitRetries > 0) {
          try {
            console.log(`Submitting to AssemblyAI using model: ${modelToUse}...`);
            transcript = await client.transcripts.submit({
              audio: filePath,
              speech_models: [modelToUse],
              language_detection: true,
            });
            break; // Success
          } catch (innerError: any) {
            submitRetries--;
            console.warn(`AssemblyAI Submit Error with model ${modelToUse}. Retries left: ${submitRetries}. Error:`, innerError.message || innerError);
            
            // Switch to backup model 'universal-3-5-pro' on failure
            if (modelToUse === 'universal-2') {
              console.log('Switching to backup model: universal-3-5-pro');
              modelToUse = 'universal-3-5-pro';
            }
            
            if (submitRetries === 0) {
              throw innerError;
            }
            // Wait 5 seconds before retrying
            await new Promise(r => setTimeout(r, 5000));
          }
        }

        console.log('Successfully submitted:', transcript.id);
        res.json({ id: transcript.id, fileName });
      } catch (innerError: any) {
        console.error('AssemblyAI Submission Error:', innerError);
        res.status(500).json({ 
          error: 'AssemblyAI Submission Failed', 
          details: innerError.message,
          message: 'The transcription service is currently busy or rejected the file. Please wait and try again.'
        });
      } finally {
        // Clean up uploaded file from temp queue after successful submission to Assembly AI
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }
    } catch (error: any) {
      console.error('Transcription start error:', error);
      res.status(500).json({ error: error.message || 'Internal server error' });
    }
  });

  // API Endpoint to check transcription status
  app.get('/api/status/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const transcript = await client.transcripts.get(id);

      if (transcript.status === 'error') {
        return res.json({ status: 'error', error: transcript.error });
      }

      if (transcript.status === 'completed') {
        // Fetch sentences and paragraphs for more context
        const [{ sentences }, { paragraphs }] = await Promise.all([
          client.transcripts.sentences(id),
          client.transcripts.paragraphs(id)
        ]);

        return res.json({
          status: 'completed',
          result: {
            id: transcript.id,
            text: transcript.text,
            words: transcript.words,
            sentences,
            paragraphs
          }
        });
      }

      res.json({ status: transcript.status });
    } catch (error: any) {
      console.error('Status check error:', error);
      res.status(500).json({ error: error.message || 'Internal server error' });
    }
  });

  // Error handler
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
