import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Upload, FileAudio, Download, Loader2, CheckCircle, AlertCircle, FileText, Sparkles, List, AlignLeft, Type, Files, X, Clock, Play, Pause, Sun, Moon } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleGenAI } from "@google/genai";

interface Word {
  text: string;
  start: number;
  end: number;
  confidence: number;
  speaker?: string;
}

interface Sentence {
  text: string;
  start: number;
  end: number;
  words: Word[];
}

interface Paragraph {
  text: string;
  start: number;
  end: number;
  words: Word[];
}

interface TranscriptionResult {
  fileName: string;
  id: string;
  text: string;
  words: Word[];
  sentences: Sentence[];
  paragraphs: Paragraph[];
  srt?: string;
}

interface ProcessStep {
  id: string;
  label: string;
  status: 'pending' | 'active' | 'completed' | 'error';
  timestamp?: number;
}

interface QueueItem {
  id: string;
  file: File;
  fileId?: string;
  isUploading?: boolean;
  status: 'pending' | 'waiting' | 'transcribing' | 'gemini-crafting' | 'completed' | 'error';
  result?: TranscriptionResult;
  error?: string;
  startTime?: number;
  elapsedTime?: number;
  steps: ProcessStep[];
}

type TabType = 'transcript' | 'sentences' | 'paragraphs' | 'ai-subtitles' | 'assembly-json' | 'gemini-transcript';

const CONCURRENCY_LIMIT = 1;

function cleanAndParseJSON(text: string): { srt: string, correctedText: string } {
  const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  
  // Try normal parse
  try {
    const parsed = JSON.parse(clean);
    return {
      srt: parsed.srt || '',
      correctedText: parsed.correctedText || ''
    };
  } catch (e) {
    // Try to extract only the JSON object
    const startIdx = clean.indexOf('{');
    const endIdx = clean.lastIndexOf('}');
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      const extracted = clean.substring(startIdx, endIdx + 1);
      try {
        const parsed = JSON.parse(extracted);
        return {
          srt: parsed.srt || '',
          correctedText: parsed.correctedText || ''
        };
      } catch (innerE) {
        // Continue to other parsing options
      }
    }

    // If it has "correctedText": and "srt": keys, let's try a regex fallback to parse them
    try {
      const correctedTextMatch = clean.match(/"correctedText"\s*:\s*"([\s\S]*?)"\s*,\s*"srt"/i) || clean.match(/"correctedText"\s*:\s*"([\s\S]*?)"\s*}/i);
      const srtMatch = clean.match(/"srt"\s*:\s*"([\s\S]*?)"\s*}/i) || clean.match(/"srt"\s*:\s*"([\s\S]*?)"\s*,\s*"correctedText"/i);
      
      if (correctedTextMatch || srtMatch) {
        let correctedText = '';
        let srt = '';
        
        if (correctedTextMatch) {
          correctedText = correctedTextMatch[1]
            .replace(/\\"/g, '"')
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\r')
            .replace(/\\t/g, '\t');
        }
        
        if (srtMatch) {
          srt = srtMatch[1]
            .replace(/\\"/g, '"')
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\r')
            .replace(/\\t/g, '\t');
        }
        
        if (srt || correctedText) {
          return { srt, correctedText };
        }
      }
    } catch (regexE) {
      // Regex parsing failed
    }

    throw e; // rethrow to trigger repairJSONWithGemini
  }
}

async function repairJSONWithGemini(rawText: string, modelName: string = "gemini-3.5-flash"): Promise<{ srt: string, correctedText: string }> {
  try {
    const ai = new GoogleGenAI({ apiKey: "AIzaSyDxKeT9qVM_zEi5AM81wR5QfAYkehwQkRU" });
    const repairPrompt = `
      You are a JSON recovery agent. You received a malformed JSON string representing subtitles data, which failed to parse due to unexpected characters, unescaped newlines/quotes, or extra non-JSON text.
      
      Here is the raw text received:
      <raw_text>
      ${rawText}
      </raw_text>
      
      Your job is to repair this text into a perfectly valid, standard JSON object with EXACTLY this schema:
      {
        "correctedText": "The full reconstructed transcript text with perfect punctuation",
        "srt": "The final clean SRT content"
      }
      
      Ensure that:
      - All control characters and newlines within JSON string values are properly escaped (e.g., use \\n for newlines).
      - All double quotes within the SRT content are escaped properly as \\".
      - Output ONLY the raw JSON object and nothing else. No markdown wrappers.
    `;

    const response = await ai.models.generateContent({
      model: modelName,
      contents: repairPrompt,
      config: {
        responseMimeType: "application/json"
      }
    });

    const text = response.text || '{}';
    return cleanAndParseJSON(text);
  } catch (err) {
    console.error("Failed to repair JSON with Gemini:", err);
    throw err;
  }
}

function adjustHinglishSrtTimestamps(srtText: string): string {
  if (!srtText) return srtText;
  
  // Normalize line endings and trim
  const normalizedSrt = srtText.replace(/\r\n/g, '\n').trim();
  
  // Split into blocks by double or multiple newlines
  const blocks = normalizedSrt.split(/\n\n+/);
  
  interface SrtBlock {
    indexStr: string;
    startTimeMs: number;
    endTimeMs: number;
    textLines: string[];
  }
  
  // Parse SRT time string (HH:MM:SS,mmm or HH:MM:SS.mmm) to milliseconds
  const timeToMs = (timeStr: string): number => {
    const parts = timeStr.trim().split(/[:,\.]/);
    if (parts.length < 4) return 0;
    const hrs = parseInt(parts[0], 10) || 0;
    const mins = parseInt(parts[1], 10) || 0;
    const secs = parseInt(parts[2], 10) || 0;
    const ms = parseInt(parts[3], 10) || 0;
    return hrs * 3600000 + mins * 60000 + secs * 1000 + ms;
  };
  
  // Format milliseconds back to HH:MM:SS,mmm
  const msToTime = (ms: number): string => {
    const hrs = Math.floor(ms / 3600000);
    const mins = Math.floor((ms % 3600000) / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    const msecs = Math.floor(ms % 1000);
    
    const pad = (num: number, size: number) => num.toString().padStart(size, '0');
    return `${pad(hrs, 2)}:${pad(mins, 2)}:${pad(secs, 2)},${pad(msecs, 3)}`;
  };
  
  const parsedBlocks: SrtBlock[] = [];
  
  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length < 2) continue;
    
    const indexStr = lines[0];
    const timeLine = lines[1];
    const textLines = lines.slice(2);
    
    if (!timeLine.includes('-->')) continue;
    
    const timeParts = timeLine.split('-->');
    if (timeParts.length !== 2) continue;
    
    const startTimeMs = timeToMs(timeParts[0]);
    const endTimeMs = timeToMs(timeParts[1]);
    
    parsedBlocks.push({
      indexStr,
      startTimeMs,
      endTimeMs,
      textLines
    });
  }
  
  // Adjust ending time based on gap size
  for (let i = 0; i < parsedBlocks.length - 1; i++) {
    const current = parsedBlocks[i];
    const next = parsedBlocks[i + 1];
    
    if (next.startTimeMs > current.endTimeMs) {
      const gap = next.startTimeMs - current.endTimeMs;
      if (gap < 100) {
        // Gap is below 100ms, fill the gap completely
        current.endTimeMs = next.startTimeMs;
      } else {
        // Gap is 100ms or more, add 60ms as a safe addition
        current.endTimeMs = current.endTimeMs + 60;
      }
    }
  }
  
  // Reconstruct the SRT string
  return parsedBlocks.map(block => {
    const formattedStartTime = msToTime(block.startTimeMs);
    const formattedEndTime = msToTime(block.endTimeMs);
    return `${block.indexStr}\n${formattedStartTime} --> ${formattedEndTime}\n${block.textLines.join('\n')}`;
  }).join('\n\n');
}

export default function App() {
  const [isDark, setIsDark] = useState(true);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [activeTab, setActiveTab] = useState<TabType>('ai-subtitles');
  const [selectedQueueId, setSelectedQueueId] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isQueueRunning, setIsQueueRunning] = useState(false);
  const [useHinglish, setUseHinglish] = useState(false);
  const [fillGap, setFillGap] = useState(false);
  const [userSegments, setUserSegments] = useState<string | null>(null);
  const [userSegmentsFileName, setUserSegmentsFileName] = useState<string | null>(null);
  const [elapsedTimers, setElapsedTimers] = useState<Record<string, number>>({});
  const [customInstructions, setCustomInstructions] = useState('');
  const [showAdjustPanel, setShowAdjustPanel] = useState(false);
  const [isAdjusting, setIsAdjusting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const segmentInputRef = useRef<HTMLInputElement>(null);
  const processingIdRef = useRef<string | null>(null);

  const INITIAL_STEPS: ProcessStep[] = [
    { id: 'hold', label: 'Stabilization Hold', status: 'pending' },
    { id: 'upload', label: 'Processing & Connection', status: 'pending' },
    { id: 'transcribe', label: 'Core Transcription Engine', status: 'pending' },
    { id: 'gemini', label: 'Gemini AI Refinement', status: 'pending' },
    { id: 'finalize', label: 'SRT Content Synthesis', status: 'pending' },
    { id: 'cooldown', label: 'Queue Sync & Cooldown', status: 'pending' },
  ];

  const handleFiles = (newFiles: File[]) => {
    const newItems: QueueItem[] = newFiles.map(file => ({
      id: Math.random().toString(36).substr(2, 9),
      file,
      status: 'pending',
      steps: INITIAL_STEPS.map(step => ({ ...step }))
    }));
    setQueue(prev => [...prev, ...newItems]);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      handleFiles(Array.from(e.target.files) as File[]);
    }
  };

  const handleSegmentFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const text = event.target?.result as string;
        setUserSegments(text);
        setUserSegmentsFileName(file.name);
      };
      reader.readAsText(file);
    }
  };

  const clearSegments = (e: React.MouseEvent) => {
    e.stopPropagation();
    setUserSegments(null);
    setUserSegmentsFileName(null);
    if (segmentInputRef.current) {
      segmentInputRef.current.value = '';
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files) {
      handleFiles(Array.from(e.dataTransfer.files) as File[]);
    }
  };

  const removeFile = (id: string) => {
    setQueue(prev => prev.filter(item => item.id !== id));
    if (selectedQueueId === id) setSelectedQueueId(null);
  };

  const generateSRTWithGemini = async (words: Word[], fileName: string, file: File, translateToHinglish: boolean, userSegments: string | null = null, fillGap: boolean = false, modelName: string = "gemini-3.5-flash", customPrompt: string = ""): Promise<{ srt: string, correctedText: string }> => {
    try {
      const ai = new GoogleGenAI({ apiKey: "AIzaSyDxKeT9qVM_zEi5AM81wR5QfAYkehwQkRU" });

      let parts: any[] = [];
      let prompt = '';

      const gapReductionConstraint = fillGap 
        ? `Adjust the END timestamp of every segment to COMPLETELY FILL THE GAP between consecutive segments, leaving zero space or gap between them.
             - Extend the END timestamp of every segment so that it EXACTLY equals the START timestamp of the very next/subsequent segment (e.g., if Segment 2 starts at 00:00:01,780, then Segment 1 MUST end at exactly 00:00:01,780).
             - Do not change or shift the starting time of any segment. Keep the original starting times intact.`
        : `Do NOT perform any gap filling or extension of the segment end times.
             - Keep the original timestamps exactly as they are in the AssemblyAI input.
             - Only ensure there are no overlaps (where a segment's end time is greater than the subsequent segment's start time).`;

      const timestampFormatGuide = `
          TIMING & TIMESTAMP SPECIFICATION (CRITICAL - MATHEMATICAL PRECISION MANDATORY):
          1. INPUT TIMESTAMPS: The 'start' and 'end' values in the 'AssemblyAI Reference JSON' are in MILLISECONDS (integers).
          2. SRT TIME CONVERSION: You must convert these millisecond values into standard SRT time format (HH:MM:SS,mmm) with absolute mathematical precision.
             - 1 second = 1000 milliseconds.
             - Hour (HH), Minute (MM), and Second (SS) must be 2 digits, padded with 0.
             - Millisecond (mmm) must be 3 digits, padded with 0.
             - Examples:
               - 850 milliseconds -> 00:00:00,850
               - 1780 milliseconds -> 00:00:01,780
               - 65432 milliseconds -> 00:01:05,432 (calculated precisely as: 65432 / 1000 = 65 seconds 432ms; 65 seconds is 1 minute and 5 seconds)
             - DO NOT round off, simplify, or hallucinate these values. Keep them mathematically accurate.
          3. SEGMENT START & END RULES:
             - A subtitle block (segment) is composed of a sequence of words.
             - The segment's SRT START time MUST correspond exactly to the 'start' millisecond of the FIRST word in that block.
             - The segment's SRT END time MUST correspond exactly to the 'end' millisecond of the LAST word in that block (or extended if gap-filling is enabled).
             - There must be no timing gaps between the words inside a segment and the segment boundaries.
          4. RETRY & ADJUST PRESERVATION:
             - When adjusting subtitles or applying custom instructions/retries, you MUST strictly preserve the exact mapping of timestamps from the original word list.
             - Any text spelling corrections, punctuation additions, translations, casing, or word replacements must NOT alter or drift the starting and ending times of the subtitle blocks. Keep them perfectly synced with the original millisecond timestamps.
      `;

      if (translateToHinglish) {
        // Convert file to base64 for Gemini ONLY when Hinglish translation is enabled (requires audio cross-checking)
        const fileBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const base64 = (reader.result as string).split(',')[1];
            resolve(base64);
          };
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });

        parts.push({
          inlineData: {
            data: fileBase64,
            mimeType: file.type
          }
        });

        prompt = `
          You are an expert subtitle editor and transcriber.
          
          INPUTS:
          1. AUDIO: (Provided as binary/inline data).
          2. ASSEMBLYAI DATA: A JSON array of words with start/end timestamps from a different engine.
          ${userSegments ? `3. USER PROVIDED SEGMENTS: ${userSegments}` : ''}
          
          TASK (The "Gemini Correction + Hinglish Translation" Workflow):
          1. GEMINI TRANSCRIPTION & HINGLISH TRANSLATION: First, you must listen to the provided audio yourself and transcribe it with perfect accuracy. importantly, convert all text to Hinglish (Hindi written in Latin script).
             Example: "You need the right guide" -> "Tumhein sahi guide chahiye"
             Example: "All government schemes" -> "Sabhi sarkari yojnaon"
          2. COMPARISON & CORRECTION: Compare your inner Hinglish transcription with the provided AssemblyAI word list. 
          3. MASTER TRANSCRIPT: Using your Hinglish transcription as the cleaner reference, map and replace the AssemblyAI words. Correct wrong words, missing words, and spelling errors, formatting everything to Hinglish.
          4. TIMESTAMP MAPPING (CRITICAL): You MUST keep the precise word-level start/end timestamps from AssemblyAI. If you add/correct a word, map it to the closest original timestamp.
          5. GENERATE SRT: Create an SRT file based on this corrected Master Transcript.
          
          STRICT CONSTRAINTS:
          ${userSegments ? `
          1. FOLLOW USER SEGMENTS EXACTLY: You MUST use the segments provided in the "USER PROVIDED SEGMENTS" input. Each segment in the SRT should correspond exactly to one segment provided by the user.
          2. DO NOT SELF-SEGMENT: Ignore standard word-limit constraints (like 2-4 words) if user segments are provided.
          ` : `
          1. Each segment MUST have a minimum of 2 words and a maximum of 4 words.
          2. PUNCTUATION BREAK (CRITICAL): If a word ends with punctuation (like a comma ",", full stop ".", question mark "?", or exclamation "!"), that segment MUST end there. NO words should follow punctuation within the same segment.
          `}
          3. NUMERICAL NUMBERS & RANGES: Always write numbers in digits, NOT words. Convert Hindi number multipliers (sau, hazar, lakh) accurately.
             - "do hazar" -> "2000", "pachas" -> "50", "aath sau" -> "800", "barah sau" -> "1200".
             - Ranges: "aath sau se barah sau" -> "800 se 1200" or "800-1200".
          4. NO SKIPPING: Include every single word and letter. Do not summarize.
          5. NO WORD BREAKING: Ensure every word is complete. 
          6. GAP REDUCTION & TIMESTAMP ADJUSTMENT (CRITICAL): ${gapReductionConstraint}
          7. CURRENCY FORMATTING: Always change "rupee", "rupees", "rupaye", or "rupiya" to the symbol "₹" placed BEFORE the number.
             - "1 rupee" -> "₹1", "500 rupaye" -> "₹500".
          
          LOGIC FLOW:
          - Listen to audio -> Correct words/punctuation in the word list -> Maintain timestamps -> Generate JSON.
          
          ${timestampFormatGuide}

          JSON DATA (AssemblyAI Reference):
          ${JSON.stringify(words.map(w => ({ text: w.text, start: w.start, end: w.end })))}
          
          Return ONLY a JSON object with the following structure:
          {
            "correctedText": "The full reconstructed transcript in Hinglish with perfect punctuation",
            "srt": "The final SRT content"
          }
        `;
      } else {
        // Hinglish translation is disabled: Skip audio, skip transcription/crosschecking, purely segment AssemblyAI data
        prompt = `
          You are an expert subtitle editor and segmenter. 
          Note: You are NOT transcribing or translating the audio. No audio file binary is provided.
          
          INPUTS:
          1. ASSEMBLYAI DATA: A JSON array of words with start/end timestamps representing the raw transcript.
          ${userSegments ? `2. USER PROVIDED SEGMENTS: ${userSegments}` : ''}
          
          TASK:
          1. PRESERVE ORIGINAL WORDS & LANGUAGE EXACTLY: Do NOT translate, modify, or change spelling of any words from the ASSEMBLYAI DATA. Whether the language is Arabic, Hindi, English, Spanish, or anything else, keep all words exactly as they are in the AssemblyAI data.
          2. SEGMENTATION: Segment the provided words into timed subtitle blocks to generate an SRT file.
          3. TIMESTAMP MAPPING (CRITICAL): Ensure each word keeps its original start and end timestamps. Do not invent or change word start times.
          
          STRICT CONSTRAINTS:
          ${userSegments ? `
          - FOLLOW USER SEGMENTS EXACTLY: Group/segment the AssemblyAI words strictly matching the text phrases provided in the "USER PROVIDED SEGMENTS" list. One segment in the USER PROVIDED SEGMENTS must map to exactly one SRT block.
          - DO NOT SELF-SEGMENT: Ignore standard word-limit constraints (like 2-4 words) if user segments are provided.
          ` : `
          - Each segment MUST have a minimum of 2 words and a maximum of 4 words.
          - PUNCTUATION BREAK (CRITICAL): If a word ends with punctuation (like a comma ",", full stop ".", question mark "?", or exclamation "!"), that segment MUST end there. NO words should follow punctuation within the same segment.
          `}
          - GAP REDUCTION & TIMESTAMP ADJUSTMENT (CRITICAL): ${gapReductionConstraint}
          
          ${timestampFormatGuide}

          JSON DATA (AssemblyAI Reference):
          ${JSON.stringify(words.map(w => ({ text: w.text, start: w.start, end: w.end })))}
          
          Return ONLY a JSON object with the following structure:
          {
            "correctedText": "The full reconstructed original transcript",
            "srt": "The final SRT content"
          }
        `;
      }

      if (customPrompt) {
        prompt += `
          
          ADDITIONAL USER INSTRUCTIONS (CRITICAL - ALWAYS OVERRIDE CONFLICTING GUIDELINES):
          ${customPrompt}
        `;
      }

      parts.push({ text: prompt });

      const response = await ai.models.generateContent({
        model: modelName,
        contents: {
          parts: parts
        },
        config: {
          responseMimeType: "application/json"
        }
      });

      const text = response.text || '{}';
      
      let result;
      try {
        result = cleanAndParseJSON(text);
      } catch (parseError) {
        console.warn("Gemini first JSON parse failed. Initiating automatic self-healing repair...", parseError);
        try {
          // Retry automatically using repairJSONWithGemini
          result = await repairJSONWithGemini(text, "gemini-3.5-flash");
          console.log("JSON successfully self-healed by Gemini!");
        } catch (repairError) {
          console.warn("AI repair with gemini-3.5-flash failed. Retrying with gemini-3.1-flash-lite...");
          try {
            result = await repairJSONWithGemini(text, "gemini-3.1-flash-lite");
            console.log("JSON successfully self-healed by gemini-3.1-flash-lite!");
          } catch (lastError) {
            console.error("All JSON self-healing attempts failed:", lastError);
            throw new Error("Unable to parse AI interpretation. Unexpected token received.");
          }
        }
      }
      
      let finalSrt = result.srt || '';
      if (translateToHinglish) {
        finalSrt = adjustHinglishSrtTimestamps(finalSrt);
      }
      
      return {
        srt: finalSrt,
        correctedText: result.correctedText || ''
      };
    } catch (err: any) {
      const errorStr = JSON.stringify(err);
      if (
        (errorStr.includes("429") || errorStr.includes("RESOURCE_EXHAUSTED") || errorStr.includes("quota")) &&
        modelName !== "gemini-3.1-flash-lite"
      ) {
        console.warn(`Gemini primary model quota exceeded. Retrying with gemini-3.1-flash-lite...`);
        return generateSRTWithGemini(words, fileName, file, translateToHinglish, userSegments, fillGap, "gemini-3.1-flash-lite", customPrompt);
      }

      console.error(`Gemini error for ${fileName}:`, err);
      return {
        srt: `Error generating SRT for ${fileName}: ${err.message}`,
        correctedText: ''
      };
    }
  };

  const updateStep = (itemId: string, stepId: string, status: ProcessStep['status']) => {
    setQueue(prev => prev.map(item => {
      if (item.id !== itemId) return item;
      return {
        ...item,
        steps: item.steps.map(step => {
          if (step.id === stepId) {
            return { ...step, status, timestamp: Date.now() };
          }
          // If a step is being set to active, make sure previous steps are completed
          return step;
        })
      };
    }));
  };

  // Background Uploader
  useEffect(() => {
    const uploadPendingFiles = async () => {
      const itemsToUpload = queue.filter(q => q.status === 'pending' && !q.fileId && !q.isUploading);
      
      if (itemsToUpload.length === 0) return;

      const item = itemsToUpload[0]; // Upload sequentially to avoid network congestion
      
      setQueue(prev => prev.map(q => q.id === item.id ? { ...q, isUploading: true } : q));
      
      try {
        const formData = new FormData();
        formData.append('audio', item.file);

        const response = await fetch('/api/upload', {
          method: 'POST',
          body: formData,
        });

        if (!response.ok) throw new Error('Upload failed');
        const data = await response.json();
        
        setQueue(prev => prev.map(q => q.id === item.id ? { ...q, fileId: data.fileId, isUploading: false } : q));
      } catch (error) {
        console.error(`Failed to upload ${item.file.name} to temp storage:`, error);
        setQueue(prev => prev.map(q => q.id === item.id ? { ...q, isUploading: false, status: 'error', error: 'Failed to save to server.' } : q));
      }
    };

    uploadPendingFiles();
  }, [queue]);

  const processItem = useCallback(async (item: QueueItem) => {
    if (processingIdRef.current === item.id) return;
    processingIdRef.current = item.id;

    let attempt = 0;
    const maxAttempts = 3;

    while (attempt < maxAttempts) {
      attempt++;

      // 1. STABILIZATION HOLD (10 to 20 seconds)
      const delay = Math.floor(Math.random() * (20000 - 10000 + 1)) + 10000;
      setQueue(prev => prev.map(q => q.id === item.id ? { 
        ...q, 
        status: 'waiting',
        error: undefined,
        steps: attempt > 1 ? [
          { id: 'hold', label: 'Stabilization Hold', status: 'pending' },
          { id: 'upload', label: 'Processing & Connection', status: 'pending' },
          { id: 'transcribe', label: 'Core Transcription Engine', status: 'pending' },
          { id: 'gemini', label: 'Gemini AI Refinement', status: 'pending' },
          { id: 'finalize', label: 'SRT Content Synthesis', status: 'pending' },
          { id: 'cooldown', label: 'Queue Sync & Cooldown', status: 'pending' },
        ] : q.steps
      } : q));
      updateStep(item.id, 'hold', 'active');
      
      await new Promise(resolve => setTimeout(resolve, delay));
      updateStep(item.id, 'hold', 'completed');

      const startTime = Date.now();
      // Update status to transcribing and set start time
      setQueue(prev => prev.map(q => q.id === item.id ? { ...q, status: 'transcribing', startTime } : q));
      setElapsedTimers(prev => ({ ...prev, [item.id]: 0 }));

      try {
      // 2. UPLOADING TO ASSEMBLY AI (via our server)
      updateStep(item.id, 'upload', 'active');
      
      if (!item.fileId) {
         throw new Error("File hasn't been uploaded to temp drive yet. Please wait.");
      }

      const response = await fetch('/api/transcribe', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ fileId: item.fileId, fileName: item.file.name }),
      });

      const contentType = response.headers.get("content-type");
      if (!response.ok) {
        let errorMessage = 'Transcription failed';
        if (contentType && contentType.includes("application/json")) {
          try {
            const errData = await response.json();
            errorMessage = errData.message || errData.error || errorMessage;
          } catch (e) {
            errorMessage = `Server error (${response.status}): ${response.statusText}`;
          }
        } else {
          errorMessage = `Server error (${response.status}): ${response.statusText}`;
        }
        updateStep(item.id, 'upload', 'error');
        throw new Error(errorMessage);
      }
      
      if (!contentType || !contentType.includes("application/json")) {
        const textResponse = await response.text();
        console.error("Received non-JSON response from /api/transcribe. Body format:", textResponse.substring(0, 200));
        updateStep(item.id, 'upload', 'error');
        throw new Error(`Server returned unexpected format (${contentType}). Please try processing this file again.`);
      }

      updateStep(item.id, 'upload', 'completed');

      // 3. ASSEMBLYAI TRANSCRIPTION
      updateStep(item.id, 'transcribe', 'active');
      const transcribeData = await response.json();
      const transcriptId = transcribeData.id;

      let data = null;
      let pollRetries = 0;
      while (true) {
        try {
          const statusResponse = await fetch(`/api/status/${transcriptId}`);
          const statusContentType = statusResponse.headers.get("content-type");
          
          if (!statusContentType || !statusContentType.includes("application/json")) {
            throw new Error("Invalid content type received during polling");
          }

          if (!statusResponse.ok) {
            throw new Error(`Status check failed: ${statusResponse.statusText}`);
          }
          
          const statusData = await statusResponse.json();
          if (statusData.status === 'completed') {
            data = statusData.result;
            break;
          } else if (statusData.status === 'error') {
            throw new Error(statusData.error || "Transcription failed");
          }
          
          pollRetries = 0; 
        } catch (pollErr) {
          console.warn("Polling error, retrying...", pollErr);
          pollRetries++;
          if (pollRetries > 10) {
            throw new Error("Lost connection to server while polling status. Please try again.");
          }
        }
        await new Promise(resolve => setTimeout(resolve, 3000));
      }

      if (!data) throw new Error("No transcription data received");
      updateStep(item.id, 'transcribe', 'completed');
      
      // 4. GEMINI CRAFTING
      updateStep(item.id, 'gemini', 'active');
      setQueue(prev => prev.map(q => q.id === item.id ? { ...q, status: 'gemini-crafting', result: data } : q));

      const srtData = await generateSRTWithGemini(data.words, item.file.name, item.file, useHinglish, userSegments, fillGap);
      updateStep(item.id, 'gemini', 'completed');

      // 5. FINALIZE
      updateStep(item.id, 'finalize', 'active');
      const finalElapsed = Math.floor((Date.now() - startTime) / 1000);
      setQueue(prev => prev.map(q => q.id === item.id ? { 
        ...q, 
        status: 'completed', 
        result: { 
          ...data, 
          fileName: item.file.name,
          srt: srtData.srt, 
          text: srtData.correctedText || data.text 
        },
        elapsedTime: finalElapsed
      } : q));
      updateStep(item.id, 'finalize', 'completed');

      // 6. COOLDOWN
      updateStep(item.id, 'cooldown', 'active');
      await new Promise(resolve => setTimeout(resolve, 6000));
      updateStep(item.id, 'cooldown', 'completed');
      
      setElapsedTimers(prev => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });

      setSelectedQueueId(prev => prev || item.id);
      break; // Success, exit retry loop
    } catch (err: any) {
      if (attempt < maxAttempts) {
        setQueue(prev => prev.map(q => {
          if (q.id !== item.id) return q;
          return {
            ...q,
            error: `Error occurred: ${err.message}. Retrying in 10s... (Attempt ${attempt}/${maxAttempts-1})`,
            steps: q.steps.map(s => s.status === 'active' ? { ...s, status: 'error' } : s)
          };
        }));
        await new Promise(resolve => setTimeout(resolve, 10000));
      } else {
        setQueue(prev => prev.map(q => {
          if (q.id !== item.id) return q;
          return {
            ...q,
            status: 'error',
            error: err.message,
            steps: q.steps.map(s => s.status === 'active' ? { ...s, status: 'error' } : s)
          };
        }));
      }
    }
    } // End of while loop

    processingIdRef.current = null;
  }, [useHinglish, userSegments, fillGap, updateStep, generateSRTWithGemini]);

  const retryGeminiRefinement = async (item: QueueItem, customPrompt?: string) => {
    if (!item.result) {
      console.error("Cannot retry: No transcription data exists.");
      return;
    }
    
    setIsAdjusting(true);
    
    // Set status to gemini-crafting
    setQueue(prev => prev.map(q => {
      if (q.id !== item.id) return q;
      return {
        ...q,
        status: 'gemini-crafting',
        error: undefined,
        steps: q.steps.map(s => {
          if (s.id === 'gemini') return { ...s, status: 'active', timestamp: Date.now() };
          if (s.id === 'finalize') return { ...s, status: 'pending' };
          return s;
        })
      };
    }));

    try {
      const startTime = Date.now();
      setElapsedTimers(prev => ({ ...prev, [item.id]: 0 }));

      const words = item.result?.words || [];
      
      const srtData = await generateSRTWithGemini(
        words, 
        item.file.name, 
        item.file, 
        useHinglish, 
        userSegments, 
        fillGap,
        "gemini-3.5-flash",
        customPrompt
      );

      const finalElapsed = Math.floor((Date.now() - startTime) / 1000);
      setQueue(prev => prev.map(q => {
        if (q.id !== item.id) return q;
        const currentRes = q.result || {
          fileName: item.file.name,
          id: Math.random().toString(36).substr(2, 9),
          text: srtData.correctedText,
          words: [],
          sentences: [],
          paragraphs: []
        };
        return {
          ...q,
          status: 'completed',
          result: {
            ...currentRes,
            srt: srtData.srt,
            text: srtData.correctedText || currentRes.text
          },
          elapsedTime: (q.elapsedTime || 0) + finalElapsed,
          steps: q.steps.map(s => {
            if (s.id === 'gemini') return { ...s, status: 'completed', timestamp: Date.now() };
            if (s.id === 'finalize') return { ...s, status: 'completed', timestamp: Date.now() };
            return s;
          })
        };
      }));
      setCustomInstructions('');
      setShowAdjustPanel(false);
    } catch (err: any) {
      console.error("Manual Gemini retry failed:", err);
      setQueue(prev => prev.map(q => {
        if (q.id !== item.id) return q;
        return {
          ...q,
          status: 'error',
          error: `Retry failed: ${err.message}`,
          steps: q.steps.map(s => s.id === 'gemini' ? { ...s, status: 'error' } : s)
        };
      }));
    } finally {
      setIsAdjusting(false);
      setElapsedTimers(prev => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
    }
  };


  // Timer Effect: Update elapsed time for active items separately to avoid queue re-renders
  useEffect(() => {
    if (!isQueueRunning) return;
    
    const timer = setInterval(() => {
      const now = Date.now();
      setElapsedTimers(prev => {
        const next: Record<string, number> = {};
        let changed = false;
        
        queue.forEach(q => {
          if (q.status === 'transcribing' || q.status === 'gemini-crafting') {
            const elapsed = Math.floor((now - (q.startTime || now)) / 1000);
            if (prev[q.id] !== elapsed) {
              next[q.id] = elapsed;
              changed = true;
            } else {
              next[q.id] = prev[q.id];
            }
          }
        });
        
        return changed ? next : prev;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [isQueueRunning, queue]);

  // Queue Manager Effect: Single-File Logic
  useEffect(() => {
    if (!isQueueRunning) return;

    const activeCount = queue.filter(q => q.status === 'transcribing' || q.status === 'gemini-crafting' || q.status === 'waiting' || q.status === 'cooldown').length;
    // Only process items that are successfully uploaded to temp storage
    const pendingItems = queue.filter(q => q.status === 'pending' && q.fileId);
    
    // Only start a new item if no items are currently active
    if (activeCount === 0 && pendingItems.length > 0 && !processingIdRef.current) {
      // Take the next item
      const nextItem = pendingItems[0];
      processItem(nextItem);
    } else if (activeCount === 0 && pendingItems.length === 0 && queue.filter(q => q.status === 'pending').length === 0) {
      setIsQueueRunning(false);
    }
  }, [queue, processItem, isQueueRunning]);

  const downloadSRT = (result: TranscriptionResult) => {
    try {
      if (!result.srt) {
        console.error("No SRT content to download");
        return;
      }
      const blob = new Blob([result.srt], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      
      const safeFileName = (result.fileName || 'transcript').split('.')[0] || 'transcript';
      a.download = `${safeFileName}.srt`;
      
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 100);
    } catch (err) {
      console.error("Download failed:", err);
      alert("Failed to download SRT file. Please check console for details.");
    }
  };

  const formatTime = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const selectedItem = queue.find(q => q.id === selectedQueueId);
  const currentResult = selectedItem?.result;

  const stats = {
    pending: queue.filter(q => q.status === 'pending').length,
    active: queue.filter(q => q.status === 'transcribing' || q.status === 'gemini-crafting' || q.status === 'waiting').length,
    completed: queue.filter(q => q.status === 'completed').length,
    error: queue.filter(q => q.status === 'error').length,
  };

  return (
    <div className={`min-h-screen font-sans selection:bg-indigo-500/20 pb-20 transition-all duration-300 ${isDark ? 'bg-slate-950 text-slate-100' : 'bg-slate-50 text-slate-900'}`}>
      {/* Header */}
      <header className={`py-6 sticky top-0 z-20 transition-all duration-300 border-b backdrop-blur-md ${isDark ? 'bg-slate-900/80 border-slate-800 text-white' : 'bg-white/85 border-slate-200 text-slate-900'}`}>
        <div className="max-w-7xl mx-auto px-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-indigo-600 p-2 rounded-lg">
              <FileAudio className="text-white w-6 h-6" />
            </div>
            <h1 className="text-xl font-bold tracking-tight">SubGen AI Pro</h1>
          </div>
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-4 text-xs font-bold uppercase tracking-widest text-slate-400">
              <span className="flex items-center gap-1.5 text-indigo-500">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> {stats.active} Active
              </span>
              <span className="flex items-center gap-1.5 text-emerald-500">
                <CheckCircle className="w-3.5 h-3.5" /> {stats.completed} Done
              </span>
            </div>
            <div className={`h-6 w-px ${isDark ? 'bg-slate-800' : 'bg-slate-200'}`} />
            <div className={`text-sm font-medium flex items-center gap-2 ${isDark ? 'text-slate-300' : 'text-slate-500'}`}>
              <Sparkles className="w-4 h-4 text-indigo-500" />
              {useHinglish ? 'Hinglish Mode' : 'Universal Mode'}
            </div>
            <div className={`h-6 w-px ${isDark ? 'bg-slate-800' : 'bg-slate-200'}`} />
            <button
              onClick={() => setIsDark(!isDark)}
              className={`p-2 rounded-xl transition-all duration-300 ${
                isDark 
                  ? 'bg-slate-850 text-amber-400 hover:bg-slate-800 hover:scale-105 border border-slate-700/50' 
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200 hover:scale-105 border border-slate-200'
              }`}
              title={isDark ? "Switch to Light Theme" : "Switch to Dark Theme"}
            >
              {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-12">
        <div className="text-center mb-12">
          <h2 className={`text-4xl font-extrabold mb-4 tracking-tight transition-colors duration-300 ${isDark ? 'text-white' : 'text-slate-900'}`}>
            High-Concurrency Subtitle Engine
          </h2>
          <p className={`text-lg max-w-2xl mx-auto transition-colors duration-300 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
            Processing files one by one to ensure maximum accuracy and stability.
          </p>
        </div>

        {/* Upload Section */}
        <div className={`rounded-2xl shadow-sm border p-8 mb-12 transition-all duration-300 ${isDark ? 'bg-slate-900 border-slate-800 shadow-slate-950/20' : 'bg-white border-slate-200'}`}>
          <div 
            className={`border-2 border-dashed rounded-xl p-12 text-center transition-all cursor-pointer ${
              isDragging 
                ? (isDark ? 'border-indigo-500 bg-indigo-950/20 scale-[1.01]' : 'border-indigo-500 bg-indigo-50 scale-[1.01]') 
                : (isDark ? 'border-slate-800 bg-slate-900/40 hover:border-indigo-500/50 hover:bg-slate-900/80' : 'border-slate-200 hover:border-indigo-300 hover:bg-slate-50/50')
            }`}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <input 
              type="file" 
              ref={fileInputRef}
              onChange={handleFileChange}
              className="hidden"
              accept="audio/*,video/*"
              multiple
            />
            
            <div className="flex flex-col items-center gap-4">
              <div className={`p-4 rounded-full transition-colors ${isDragging ? 'bg-indigo-600 text-white' : (isDark ? 'bg-slate-850 text-slate-400' : 'bg-slate-100 text-slate-400')}`}>
                <Files className="w-8 h-8" />
              </div>
              <div>
                <p className={`text-lg font-semibold transition-colors duration-300 ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                  {isDragging ? 'Drop files here' : 'Click or drag and drop audio files here'}
                </p>
                <p className={`text-sm mt-1 transition-colors duration-300 ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>
                  Files will be added to the queue below. Click "Start Processing" to begin.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Queue & Results Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* Sidebar: Queue Manager */}
          <div className="lg:col-span-4 space-y-4">
            <div className={`border rounded-2xl p-4 shadow-sm mb-4 transition-all duration-300 ${isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
              <div className="flex items-center justify-between mb-4">
                <h3 className={`text-sm font-bold uppercase tracking-wider flex items-center gap-2 ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                  <List className="w-4 h-4 text-indigo-500" />
                  Queue Manager
                </h3>
                <span className={`text-xs font-bold ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{queue.length} Total</span>
              </div>
              
              {queue.length > 0 && (
                <button
                  onClick={() => setIsQueueRunning(!isQueueRunning)}
                  className={`w-full py-3 rounded-xl text-sm font-bold flex items-center justify-center gap-2 transition-all ${
                    isQueueRunning 
                      ? (isDark ? 'bg-red-950/40 text-red-400 hover:bg-red-950/60 border border-red-900/50' : 'bg-red-50 text-red-600 hover:bg-red-100 border border-red-100') 
                      : 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-lg shadow-indigo-100 dark:shadow-none'
                  }`}
                >
                  {isQueueRunning ? (
                    <><Pause className="w-4 h-4" /> Stop Queue</>
                  ) : (
                    <><Play className="w-4 h-4" /> Start Processing</>
                  )}
                </button>
              )}
              
              <div className={`mt-4 pt-4 border-t flex flex-col gap-4 ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
                <label className="flex items-center gap-3 cursor-pointer group">
                  <div className="relative">
                    <input 
                      type="checkbox" 
                      className="sr-only peer"
                      checked={useHinglish}
                      onChange={(e) => setUseHinglish(e.target.checked)}
                    />
                    <div className={`w-10 h-5 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-600 ${isDark ? 'bg-slate-850' : 'bg-slate-200'}`}></div>
                  </div>
                  <div className="flex flex-col">
                    <span className={`text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                      <Sparkles className={`w-3 h-3 ${useHinglish ? 'text-indigo-500' : 'text-slate-400'}`} />
                      Hinglish Translation
                    </span>
                    <span className="text-[10px] text-slate-500 font-medium">
                      {useHinglish ? 'Translating to Hinglish script' : 'Preserving original audio language'}
                    </span>
                  </div>
                </label>

                <label className={`flex items-center gap-3 cursor-pointer group border-t pt-3 ${isDark ? 'border-slate-850' : 'border-slate-50'}`}>
                  <div className="relative">
                    <input 
                      type="checkbox" 
                      className="sr-only peer"
                      checked={fillGap}
                      onChange={(e) => setFillGap(e.target.checked)}
                    />
                    <div className={`w-10 h-5 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-600 ${isDark ? 'bg-slate-850' : 'bg-slate-200'}`}></div>
                  </div>
                  <div className="flex flex-col">
                    <span className={`text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                      <Clock className={`w-3 h-3 ${fillGap ? 'text-indigo-500' : 'text-slate-400'}`} />
                      Fill the gap
                    </span>
                    <span className="text-[10px] text-slate-500 font-medium">
                      {fillGap ? 'Zero gaps between subtitle segments' : 'Maintain normal pause spacing'}
                    </span>
                  </div>
                </label>
              </div>

              <div className={`mt-4 pt-4 border-t ${isDark ? 'border-slate-800' : 'border-slate-100'}`}>
                <input 
                  type="file" 
                  ref={segmentInputRef}
                  onChange={handleSegmentFileChange}
                  className="hidden"
                  accept=".txt"
                />
                <div 
                  onClick={() => !userSegments && segmentInputRef.current?.click()}
                  className={`flex items-center gap-3 p-3 rounded-xl border border-dashed transition-all cursor-pointer ${
                    userSegments 
                      ? (isDark ? 'bg-emerald-950/20 border-emerald-800 text-emerald-400' : 'bg-emerald-50 border-emerald-200 text-emerald-700') 
                      : (isDark ? 'bg-slate-900 border-slate-800 text-slate-400 hover:border-slate-700 hover:bg-slate-800/50' : 'bg-slate-50 border-slate-200 text-slate-500 hover:border-indigo-300 hover:bg-slate-100')
                  }`}
                >
                  <div className={`p-1.5 rounded-lg ${userSegments ? 'bg-emerald-500 text-white' : (isDark ? 'bg-slate-800 text-slate-500' : 'bg-slate-200 text-slate-400')}`}>
                    <AlignLeft className="w-3.5 h-3.5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-[10px] font-bold uppercase tracking-[0.1em] ${isDark && !userSegments ? 'text-slate-400' : ''}`}>
                      {userSegments ? 'Segment File Loaded' : 'Reference Segments'}
                    </p>
                    <p className={`text-[10px] truncate font-medium ${isDark ? 'text-slate-500' : ''}`}>
                      {userSegmentsFileName || 'Upload .txt file'}
                    </p>
                  </div>
                  {userSegments && (
                    <button 
                      onClick={clearSegments}
                      className={`p-1 rounded-md transition-colors ${isDark ? 'hover:bg-emerald-900/40 text-emerald-400' : 'hover:bg-emerald-100 text-emerald-700'}`}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>
            </div>
            
            <div className="space-y-2 max-h-[600px] overflow-y-auto pr-2 scrollbar-thin scrollbar-thumb-slate-800/50">
              <AnimatePresence initial={false}>
                {queue.map((item) => (
                  <motion.div
                    key={item.id}
                    layout
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 20 }}
                    className={`group relative p-3 rounded-xl border transition-all cursor-pointer ${
                      selectedQueueId === item.id 
                        ? 'bg-indigo-600 border-indigo-600 text-white shadow-lg shadow-indigo-100/20' 
                        : (isDark ? 'bg-slate-900 border-slate-800 text-slate-300 hover:bg-slate-850' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50')
                    }`}
                    onClick={() => setSelectedQueueId(item.id)}
                  >
                    <div className="flex items-center gap-3">
                      <div className={`p-2 rounded-lg ${
                        selectedQueueId === item.id ? 'bg-white/20' : (isDark ? 'bg-slate-800' : 'bg-slate-100')
                      }`}>
                        {item.status === 'completed' ? (
                          <CheckCircle className={`w-4 h-4 ${selectedQueueId === item.id ? 'text-white' : 'text-emerald-500'}`} />
                        ) : item.status === 'error' ? (
                          <AlertCircle className="w-4 h-4 text-red-500" />
                        ) : item.status === 'pending' || item.status === 'waiting' ? (
                          <Clock className={`w-4 h-4 ${item.status === 'waiting' ? 'text-amber-500 animate-pulse' : 'text-slate-400'}`} />
                        ) : (
                          <Loader2 className={`w-4 h-4 animate-spin ${selectedQueueId === item.id ? 'text-white' : 'text-indigo-500'}`} />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        {item.fileId || item.status !== 'pending' ? (
                          <>
                            <p className="text-sm font-bold truncate">{item.file.name}</p>
                            <div className="flex items-center gap-2">
                              <p className={`text-[10px] uppercase tracking-wider font-bold ${
                                selectedQueueId === item.id ? 'text-indigo-100' : (isDark ? 'text-slate-500' : 'text-slate-400')
                              }`}>
                                {item.status}
                              </p>
                              {(item.elapsedTime !== undefined || elapsedTimers[item.id] !== undefined) && (
                                <span className={`text-[10px] font-mono ${selectedQueueId === item.id ? 'text-indigo-200' : (isDark ? 'text-slate-500' : 'text-slate-400')}`}>
                                  • {item.elapsedTime ?? elapsedTimers[item.id]}s
                                </span>
                              )}
                            </div>
                          </>
                        ) : (
                          <>
                            <p className="text-sm font-bold truncate">{item.file.name}</p>
                            <div className="flex items-center gap-2">
                              <p className="text-[10px] uppercase tracking-wider font-bold text-indigo-500 animate-pulse">
                                Uploading to Server...
                              </p>
                            </div>
                          </>
                        )}
                      </div>
                      <button 
                        onClick={(e) => { e.stopPropagation(); removeFile(item.id); }}
                        className={`opacity-0 group-hover:opacity-100 p-1 rounded-md transition-opacity ${
                          selectedQueueId === item.id ? 'hover:bg-white/20 text-white' : (isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-200 text-slate-400')
                        }`}
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
              
              {queue.length === 0 && (
                <div className={`text-center py-12 border border-dashed rounded-2xl ${isDark ? 'bg-slate-900 border-slate-800 text-slate-500' : 'text-slate-400 bg-white border-slate-200'}`}>
                  <p className="text-slate-500 text-sm">No files in queue</p>
                </div>
              )}
            </div>
          </div>

          {/* Main Content: Tabs & Preview */}
          <div className="lg:col-span-8">
            <AnimatePresence mode="wait">
              {selectedItem ? (
                <motion.div
                  key={selectedItem.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  className="space-y-6"
                >
                  <div className={`border rounded-2xl overflow-hidden shadow-sm transition-all duration-300 ${isDark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
                    <div className={`flex border-b p-1 ${isDark ? 'border-slate-800 bg-slate-950/50' : 'border-slate-200 bg-slate-50/50'}`}>
                      {[
                        { id: 'ai-subtitles', label: useHinglish ? 'AI Subtitles (Hinglish)' : 'AI Subtitles (Original)', icon: Sparkles },
                        { id: 'gemini-transcript', label: 'AI Transcription', icon: Sparkles },
                        { id: 'transcript', label: 'Original Transcript', icon: Type },
                        { id: 'sentences', label: 'Sentences', icon: List },
                        { id: 'paragraphs', label: 'Paragraphs', icon: AlignLeft },
                        { id: 'assembly-json', label: 'AssemblyAI JSON', icon: Files },
                      ].map((tab) => (
                        <button
                          key={tab.id}
                          onClick={() => setActiveTab(tab.id as TabType)}
                          className={`flex-1 flex items-center justify-center gap-2 py-3 px-4 rounded-xl font-bold text-sm transition-all ${
                            activeTab === tab.id 
                              ? (isDark ? 'bg-slate-800 text-indigo-400 shadow-sm' : 'bg-white text-indigo-600 shadow-sm') 
                              : (isDark ? 'text-slate-400 hover:text-slate-250 hover:bg-slate-800/40' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100/50')
                          }`}
                        >
                          <tab.icon className={`w-4 h-4 ${activeTab === tab.id ? (isDark ? 'text-indigo-400' : 'text-indigo-600') : 'text-slate-450'}`} />
                          <span className="hidden sm:inline">{tab.label}</span>
                        </button>
                      ))}
                    </div>

                    <div className="p-8 min-h-[500px]">
                      <div className="flex items-center justify-between mb-6">
                        <div>
                          <h4 className={`text-xl font-bold truncate max-w-[400px] ${isDark ? 'text-white' : 'text-slate-800'}`}>
                            {selectedItem.file.name}
                          </h4>
                          <div className="flex items-center gap-2 mt-1">
                            <span className={`text-xs font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${
                              selectedItem.status === 'completed' ? (isDark ? 'bg-emerald-950/50 text-emerald-400 border border-emerald-900/30' : 'bg-emerald-100 text-emerald-700') :
                              selectedItem.status === 'error' ? (isDark ? 'bg-red-950/50 text-red-400 border border-red-900/30' : 'bg-red-100 text-red-700') :
                              (isDark ? 'bg-indigo-950/50 text-indigo-400 border border-indigo-900/30' : 'bg-indigo-100 text-indigo-700')
                            }`}>
                              {selectedItem.status}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          {selectedItem.result && (selectedItem.status === 'completed' || selectedItem.status === 'error') && (
                            <button
                              onClick={() => setShowAdjustPanel(prev => !prev)}
                              className={`px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 transition-colors border ${
                                showAdjustPanel 
                                  ? (isDark ? 'bg-amber-950/40 text-amber-400 border-amber-900/50' : 'bg-amber-50 text-amber-700 border-amber-200') 
                                  : (isDark ? 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700' : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-200')
                              }`}
                            >
                              <Sparkles className="w-4 h-4 text-amber-500 animate-pulse" />
                              Adjust / Retry AI
                            </button>
                          )}
                          {currentResult?.srt && (
                            <button
                              onClick={() => downloadSRT(currentResult)}
                              className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 transition-colors shadow-lg shadow-indigo-100 dark:shadow-none"
                            >
                              <Download className="w-4 h-4" />
                              Download SRT
                            </button>
                          )}
                        </div>
                      </div>

                      {/* AI Subtitle Fine-Tuning Panel */}
                      <AnimatePresence>
                        {showAdjustPanel && selectedItem.result && (
                          <motion.div
                            initial={{ opacity: 0, height: 0, marginBottom: 0 }}
                            animate={{ opacity: 1, height: 'auto', marginBottom: 24 }}
                            exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                            className={`rounded-xl p-5 border overflow-hidden transition-all duration-300 ${
                              isDark ? 'bg-slate-900 border-slate-800' : 'bg-slate-50 border-slate-200'
                            }`}
                          >
                            <h5 className={`text-xs font-bold uppercase tracking-wider mb-2 flex items-center gap-2 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                              <Sparkles className="w-4 h-4 text-amber-500" />
                              Adjust SRT / Fine-Tune Subtitles
                            </h5>
                            <p className={`text-xs mb-4 ${isDark ? 'text-slate-500' : 'text-slate-600'}`}>
                              Enter specific corrections, guidelines, word replacements, or formatting preferences. Gemini will regenerate the SRT file instantly using your saved transcription data without re-transcribing.
                            </p>
                            <div className="space-y-4">
                              <textarea
                                value={customInstructions}
                                onChange={(e) => setCustomInstructions(e.target.value)}
                                placeholder="Example: Convert any occurrences of 'Rs' to '₹'. Keep sentences extremely short (max 2-3 words). Correct spellings of names..."
                                className={`w-full p-3 rounded-xl border text-sm font-medium focus:ring-2 focus:ring-indigo-500 focus:outline-none transition-all ${
                                  isDark 
                                    ? 'bg-slate-950 border-slate-800 text-white placeholder-slate-600' 
                                    : 'bg-white border-slate-200 text-slate-800 placeholder-slate-400'
                                }`}
                                rows={3}
                              />
                              <div className="flex justify-end gap-3">
                                <button
                                  onClick={() => {
                                    setCustomInstructions('');
                                    setShowAdjustPanel(false);
                                  }}
                                  className={`px-3.5 py-2 rounded-lg text-xs font-bold transition-colors ${
                                    isDark ? 'hover:bg-slate-800 text-slate-400' : 'hover:bg-slate-200 text-slate-600'
                                  }`}
                                  disabled={isAdjusting}
                                >
                                  Cancel
                                </button>
                                <button
                                  onClick={() => retryGeminiRefinement(selectedItem, customInstructions)}
                                  className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-600/50 text-white px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-2 transition-all shadow-md"
                                  disabled={isAdjusting}
                                >
                                  {isAdjusting ? (
                                    <>
                                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                      Applying Adjustments...
                                    </>
                                  ) : (
                                    <>
                                      <Sparkles className="w-3.5 h-3.5" />
                                      Re-run AI Refinement
                                    </>
                                  )}
                                </button>
                              </div>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>

                      {/* AI Reconstructed Transcription Bar */}
                      {currentResult?.text && (
                        <div className={`p-4 rounded-xl mb-6 border flex flex-col gap-2 transition-all duration-300 ${
                          isDark ? 'bg-indigo-950/20 border-indigo-900/30 text-indigo-200' : 'bg-indigo-50 border-indigo-100 text-indigo-950'
                        }`}>
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <Sparkles className="w-4 h-4 text-indigo-500 animate-pulse" />
                              <span className="text-xs font-bold uppercase tracking-wider">AI Reconstructed Transcription Bar</span>
                            </div>
                            <button 
                              onClick={() => {
                                navigator.clipboard.writeText(currentResult.text || '');
                              }}
                              className={`text-[10px] font-bold px-2.5 py-1 rounded transition-colors ${
                                isDark ? 'bg-indigo-900/40 hover:bg-indigo-850 text-indigo-300' : 'bg-indigo-100 hover:bg-indigo-200 text-indigo-700'
                              }`}
                            >
                              Copy Text
                            </button>
                          </div>
                          <p className="text-sm font-medium line-clamp-2 hover:line-clamp-none transition-all cursor-pointer leading-relaxed">
                            {currentResult.text}
                          </p>
                        </div>
                      )}

                      {selectedItem.status === 'error' ? (
                        <div className="flex flex-col items-center justify-center py-20 text-red-500 gap-4">
                          <AlertCircle className="w-12 h-12" />
                          <div className="text-center mb-8">
                            <p className="font-bold text-lg">Processing Failed</p>
                            <p className="text-sm opacity-80">{selectedItem.error}</p>
                          </div>
                          <div className={`w-full max-w-md rounded-2xl p-6 border ${isDark ? 'bg-red-950/20 border-red-900/40 text-red-400' : 'bg-red-50 border-red-100'}`}>
                            <h5 className={`text-xs font-bold uppercase tracking-wider mb-4 px-2 ${isDark ? 'text-red-450' : 'text-red-400'}`}>Failure Log</h5>
                            <div className="space-y-4">
                              {selectedItem.steps.map((step) => (
                                <div key={step.id} className="flex items-center gap-3">
                                  <div className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 ${
                                    step.status === 'completed' ? 'bg-emerald-500 text-white' :
                                    step.status === 'active' ? 'bg-amber-500 text-white animate-pulse' :
                                    step.status === 'error' ? 'bg-red-500 text-white' :
                                    (isDark ? 'bg-slate-800 text-slate-500' : 'bg-slate-200 text-slate-400')
                                  }`}>
                                    {step.status === 'completed' ? <CheckCircle className="w-4 h-4" /> :
                                     step.status === 'error' ? <X className="w-4 h-4" /> :
                                     <div className="w-1.5 h-1.5 rounded-full bg-current" />}
                                  </div>
                                  <span className={`text-sm font-medium ${
                                    step.status === 'error' ? 'text-red-400' :
                                    step.status === 'pending' ? (isDark ? 'text-slate-600' : 'text-slate-400') : (isDark ? 'text-slate-300' : 'text-slate-700')
                                  }`}>{step.label}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      ) : (selectedItem.status !== 'completed' && selectedItem.status !== 'pending' && selectedItem.status !== 'error') ? (
                        <div className="flex flex-col items-center justify-center py-6 gap-8">
                          <div className="relative">
                            <motion.div 
                              animate={{ scale: [1, 1.1, 1], opacity: [0.3, 0.6, 0.3] }}
                              transition={{ duration: 2, repeat: Infinity }}
                              className="absolute -inset-4 bg-indigo-500/10 rounded-full blur-xl" 
                            />
                            <div className={`w-24 h-24 rounded-full border-[6px] border-t-indigo-600 animate-spin ${isDark ? 'border-slate-800' : 'border-indigo-100'}`} />
                            <div className="absolute inset-0 flex items-center justify-center">
                              <Sparkles className="w-8 h-8 text-indigo-400 animate-pulse" />
                            </div>
                          </div>
                          
                          <div className={`w-full max-w-md rounded-[2.5rem] p-10 border shadow-2xl transition-all duration-300 ${isDark ? 'bg-slate-900 border-slate-800 shadow-slate-950/50' : 'bg-white border-slate-100 shadow-indigo-100/50'}`}>
                            <h5 className={`text-[10px] font-black uppercase tracking-[0.2em] mb-8 px-2 text-center ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Neural Pipeline Active</h5>
                            <div className="space-y-6">
                              {selectedItem.steps.map((step, idx) => (
                                <motion.div 
                                  key={step.id} 
                                  initial={{ opacity: 0, x: -10 }}
                                  animate={{ opacity: 1, x: 0 }}
                                  transition={{ delay: idx * 0.1 }}
                                  className="relative"
                                >
                                  {idx !== selectedItem.steps.length - 1 && (
                                    <div className={`absolute left-[11px] top-6 bottom-[-24px] w-[2px] transition-colors duration-500 ${
                                      step.status === 'completed' ? 'bg-emerald-500' : (isDark ? 'bg-slate-800' : 'bg-slate-100')
                                    }`} />
                                  )}
                                  <div className="flex items-center gap-5">
                                    <div className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 z-10 transition-all duration-500 ${
                                      step.status === 'completed' ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-100 dark:shadow-none' :
                                      step.status === 'active' ? 'bg-indigo-600 text-white shadow-xl shadow-indigo-200 dark:shadow-none scale-125' :
                                      (isDark ? 'bg-slate-850 text-slate-600 border border-slate-800' : 'bg-slate-50 text-slate-300 border border-slate-100')
                                    }`}>
                                      {step.status === 'completed' ? (
                                        <CheckCircle className="w-3.5 h-3.5" />
                                      ) : step.status === 'active' ? (
                                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                      ) : (
                                        <div className="w-1 h-1 rounded-full bg-current" />
                                      )}
                                    </div>
                                    <div className="flex-1">
                                      <p className={`text-sm tracking-tight transition-all duration-500 ${
                                        step.status === 'pending' ? (isDark ? 'text-slate-600 font-medium' : 'text-slate-300 font-medium') : 
                                        step.status === 'active' ? (isDark ? 'text-indigo-400 font-bold' : 'text-indigo-900 font-bold') : 
                                        (isDark ? 'text-slate-200 font-semibold' : 'text-slate-900 font-semibold')
                                      }`}>
                                        {step.label}
                                      </p>
                                      {step.status === 'active' && (
                                        <motion.div 
                                          initial={{ width: 0 }}
                                          animate={{ width: "100%" }}
                                          className="h-0.5 bg-indigo-500/20 rounded-full mt-2 overflow-hidden"
                                        >
                                          <motion.div 
                                            animate={{ x: ["-100%", "100%"] }}
                                            transition={{ duration: 1.5, repeat: Infinity, ease: "linear" }}
                                            className="h-full w-1/3 bg-indigo-600 rounded-full"
                                          />
                                        </motion.div>
                                      )}
                                    </div>
                                  </div>
                                </motion.div>
                              ))}
                            </div>
                          </div>
                        </div>
                      ) : currentResult ? (
                        <>
                          {selectedItem.status === 'gemini-crafting' && (
                            <motion.div 
                              initial={{ opacity: 0, height: 0 }}
                              animate={{ opacity: 1, height: 'auto' }}
                              className={`mb-6 rounded-xl p-4 flex items-center justify-between border ${isDark ? 'bg-indigo-950/30 border-indigo-900/50 text-indigo-300' : 'bg-indigo-50 border-indigo-100 text-indigo-700'}`}
                            >
                              <div className="flex items-center gap-3">
                                <Loader2 className="w-5 h-5 animate-spin text-indigo-600" />
                                <p className={`font-bold ${isDark ? 'text-indigo-300' : 'text-indigo-700'}`}>Gemini is crafting Hinglish Subtitles... ({elapsedTimers[selectedItem.id] || 0}s)</p>
                              </div>
                              <p className={`text-xs font-medium uppercase tracking-wider ${isDark ? 'text-indigo-400/80' : 'text-indigo-500'}`}>Background Process</p>
                            </motion.div>
                          )}

                          <AnimatePresence mode="wait">
                            {activeTab === 'gemini-transcript' && (
                              <motion.div
                                key="gemini-transcript"
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -10 }}
                                className={`leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-600'}`}
                              >
                                <div className="flex items-center justify-between mb-4 pb-2 border-b border-dashed border-slate-800">
                                  <span className="text-xs font-bold text-indigo-400 uppercase tracking-wider flex items-center gap-2">
                                    <Sparkles className="w-4 h-4 text-indigo-500 animate-pulse" />
                                    Gemini Refined Text
                                  </span>
                                  <button
                                    onClick={() => {
                                      navigator.clipboard.writeText(currentResult.text || '');
                                    }}
                                    className={`text-xs font-bold px-3 py-1.5 rounded-lg transition-all ${
                                      isDark ? 'bg-indigo-950/40 hover:bg-indigo-900 text-indigo-300' : 'bg-indigo-100 hover:bg-indigo-200 text-indigo-700'
                                    }`}
                                  >
                                    Copy Transcription
                                  </button>
                                </div>
                                <p className="text-lg leading-relaxed">{currentResult.text}</p>
                              </motion.div>
                            )}

                            {activeTab === 'transcript' && (
                            <motion.div
                              key="transcript"
                              initial={{ opacity: 0, y: 10 }}
                              animate={{ opacity: 1, y: 0 }}
                              exit={{ opacity: 0, y: -10 }}
                              className={`leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-600'}`}
                            >
                              <p className="text-lg">{currentResult.text}</p>
                            </motion.div>
                          )}

                          {activeTab === 'sentences' && (
                            <motion.div
                              key="sentences"
                              initial={{ opacity: 0, y: 10 }}
                              animate={{ opacity: 1, y: 0 }}
                              exit={{ opacity: 0, y: -10 }}
                              className="space-y-4"
                            >
                              {currentResult.sentences.map((sentence, i) => (
                                <div key={i} className={`flex gap-4 p-4 rounded-xl transition-colors group ${isDark ? 'hover:bg-slate-850/50' : 'hover:bg-slate-50'}`}>
                                  <span className={`text-xs font-mono mt-1 flex-shrink-0 w-12 ${isDark ? 'text-slate-550' : 'text-slate-400'}`}>
                                    {formatTime(sentence.start)}
                                  </span>
                                  <p className={isDark ? 'text-slate-200' : 'text-slate-700'}>{sentence.text}</p>
                                </div>
                              ))}
                            </motion.div>
                          )}

                          {activeTab === 'paragraphs' && (
                            <motion.div
                              key="paragraphs"
                              initial={{ opacity: 0, y: 10 }}
                              animate={{ opacity: 1, y: 0 }}
                              exit={{ opacity: 0, y: -10 }}
                              className="space-y-8"
                            >
                              {currentResult.paragraphs.map((para, i) => (
                                <div key={i} className="space-y-2">
                                  <span className="text-xs font-bold text-indigo-500 uppercase tracking-wider">
                                    Paragraph {i + 1} • {formatTime(para.start)}
                                  </span>
                                  <p className={`leading-relaxed text-lg ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{para.text}</p>
                                </div>
                              ))}
                            </motion.div>
                          )}

                          {activeTab === 'assembly-json' && (
                            <motion.div
                              key="assembly-json"
                              initial={{ opacity: 0, y: 10 }}
                              animate={{ opacity: 1, y: 0 }}
                              exit={{ opacity: 0, y: -10 }}
                              className="relative"
                            >
                              <div className="flex items-center justify-between mb-4">
                                <h5 className="text-xs font-bold uppercase tracking-wider text-slate-500">Word-Level Data (Raw)</h5>
                                <button 
                                  onClick={() => {
                                    const blob = new Blob([JSON.stringify(currentResult.words, null, 2)], { type: 'application/json' });
                                    const url = URL.createObjectURL(blob);
                                    const a = document.createElement('a');
                                    a.href = url;
                                    a.download = `${selectedItem.file.name}_raw_words.json`;
                                    a.click();
                                  }}
                                  className="text-xs text-indigo-400 hover:text-indigo-300 font-bold flex items-center gap-1.5"
                                >
                                  <Download className="w-3 h-3" />
                                  Download JSON
                                </button>
                              </div>
                              <div className={`rounded-xl p-6 overflow-x-auto max-h-[600px] shadow-inner ${isDark ? 'bg-slate-950' : 'bg-slate-900'}`}>
                                <pre className="text-emerald-400 font-mono text-sm leading-relaxed">
                                  {JSON.stringify(currentResult.words, null, 2)}
                                </pre>
                              </div>
                            </motion.div>
                          )}

                          {activeTab === 'ai-subtitles' && (
                            <motion.div
                              key="ai-subtitles"
                              initial={{ opacity: 0, y: 10 }}
                              animate={{ opacity: 1, y: 0 }}
                              exit={{ opacity: 0, y: -10 }}
                              className="space-y-6"
                            >
                              {currentResult.srt ? (
                                <div className={`rounded-2xl p-8 shadow-inner overflow-hidden relative group ${isDark ? 'bg-slate-950' : 'bg-slate-900'}`}>
                                  <pre className={`font-mono text-sm leading-relaxed overflow-y-auto max-h-[500px] scrollbar-thin ${isDark ? 'text-slate-300 scrollbar-thumb-white/5' : 'text-slate-300 scrollbar-thumb-white/10'}`}>
                                    {currentResult.srt}
                                  </pre>
                                </div>
                              ) : (
                                <div className="flex flex-col items-center justify-center py-20 text-slate-500 gap-4">
                                  <div className="relative">
                                    <Loader2 className="w-12 h-12 animate-spin text-indigo-400" />
                                    <div className="absolute inset-0 flex items-center justify-center">
                                      <Sparkles className="w-5 h-5 text-indigo-300" />
                                    </div>
                                  </div>
                                  <div className="text-center">
                                    <p className="font-bold text-slate-500">Gemini is crafting Hinglish Subtitles... ({elapsedTimers[selectedItem.id] || 0}s)</p>
                                    <p className="text-sm mt-1">Applying Hinglish conversion and numerical rules.</p>
                                  </div>
                                </div>
                              )}
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </>
                    ) : null}
                    </div>
                  </div>
                </motion.div>
              ) : (
                <div className={`h-full flex flex-col items-center justify-center py-40 border border-dashed rounded-2xl transition-all duration-300 ${isDark ? 'bg-slate-900 border-slate-800 text-slate-500' : 'bg-white border-slate-200 text-slate-400'}`}>
                  <Files className={`w-16 h-16 mb-4 ${isDark ? 'opacity-10 text-slate-300' : 'opacity-20'}`} />
                  <p className="font-bold text-lg">Select a file from the queue</p>
                  <p className="text-sm">Upload files to start the automatic processing</p>
                </div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </main>

      <footer className={`max-w-7xl mx-auto px-4 py-12 text-center text-sm border-t mt-12 transition-colors duration-300 ${isDark ? 'border-slate-800 text-slate-500' : 'border-slate-200 text-slate-400'}`}>
        <p>© 2026 SubGen AI Pro. All rights reserved.</p>
        <p className="mt-2">Optimized for Single File Processing • Hinglish Support Enabled</p>
      </footer>
    </div>
  );
}
