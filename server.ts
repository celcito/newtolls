import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());

// Initialize Google Gemini API client
const apiKey = process.env.GEMINI_API_KEY;
let ai: GoogleGenAI | null = null;
if (apiKey) {
  ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

// API Route: Generate shape/silhouette from prompt using Google Gemini API
app.post('/api/generate-shape', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Prompt é obrigatório.' });
    }

    if (!ai) {
      return res.status(503).json({
        error: 'Chave GEMINI_API_KEY não configurada no ambiente do servidor.',
      });
    }

    const systemInstruction = `
Você é um engenheiro de modelagem e desenhista técnico especialista em vetorização de cortadores de biscoito e carimbos 3D para confeitaria.
Dada a solicitação do usuário para um ícone ou silhueta básica (ex: "coroa de rei", "foguete espacial", "dinossauro t-rex", "xícara de café", "guitarra", "árvore", "lua crescente", etc.),
gere uma geometria 2D fechada e nítida em coordenadas [X, Y] entre 0 e 100:
1. "outerPerimeter": Array de pontos [X, Y] que formam o contorno externo FECHADO da forma para o cortador (entre 18 e 45 pontos suaves e proporcionais, distribuídos em torno do centro 50, 50).
2. "innerDetails": Array de linhas internas [Array de [X, Y]], que representam os detalhes que serão carimbados em relevo no biscoito (entre 2 e 14 caminhos de linhas internas).
3. "name": Nome descritivo da forma em português.
4. "description": Breve descrição de 1 linha.
Retorne APENAS o JSON estruturado.
`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: `Gere a silhueta externa do cortador e as linhas do carimbo para o seguinte ícone: "${prompt}".`,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            name: { type: Type.STRING },
            description: { type: Type.STRING },
            outerPerimeter: {
              type: Type.ARRAY,
              items: {
                type: Type.ARRAY,
                items: { type: Type.NUMBER },
              },
            },
            innerDetails: {
              type: Type.ARRAY,
              items: {
                type: Type.ARRAY,
                items: {
                  type: Type.ARRAY,
                  items: { type: Type.NUMBER },
                },
              },
            },
          },
          required: ['name', 'outerPerimeter', 'innerDetails'],
        },
      },
    });

    const text = response.text;
    if (!text) {
      return res.status(500).json({ error: 'Nenhuma resposta retornada pela API do Google.' });
    }

    const data = JSON.parse(text);
    return res.json(data);
  } catch (error: any) {
    console.error('Erro ao gerar silhueta via Google API:', error);
    return res.status(500).json({
      error: error.message || 'Falha ao processar solicitação na API do Google.',
    });
  }
});

// Setup Vite middleware in dev or static files in production
async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true, hmr: process.env.DISABLE_HMR !== 'true' },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

startServer();
