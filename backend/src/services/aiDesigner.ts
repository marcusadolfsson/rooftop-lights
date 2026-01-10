import Anthropic from '@anthropic-ai/sdk';
import { getDatabase } from '../models/database.js';
import { v4 as uuidv4 } from 'uuid';

const anthropic = new Anthropic();

interface RGBWColor {
  r: number;
  g: number;
  b: number;
  w: number;
}

interface StaticDesign {
  type: 'static';
  name: string;
  colors: RGBWColor[];
}

interface MotionDesign {
  type: 'motion';
  name: string;
  effect: string;
  params: Record<string, unknown>;
}

type GeneratedDesign = StaticDesign | MotionDesign;

// Get the light layout context for the AI
function getLightLayoutContext(): string {
  const db = getDatabase();
  const walls = db.prepare('SELECT * FROM walls ORDER BY position').all() as Array<{
    id: string;
    name: string;
    width: number;
    height: number;
    position: number;
  }>;

  const lights = db.prepare(`
    SELECT l.*, w.name as wall_name, w.position as wall_position
    FROM lights l
    JOIN walls w ON l.wall_id = w.id
    ORDER BY w.position, l.matrix_y DESC, l.matrix_x
  `).all() as Array<{
    light_id: number;
    wall_name: string;
    matrix_x: number;
    matrix_y: number;
  }>;

  const totalLights = lights.length;
  const lightIds = lights.map(l => l.light_id).sort((a, b) => a - b);

  return `
LIGHT LAYOUT CONTEXT:
- Total lights: ${totalLights} RGBW LED fixtures
- Walls (connected in a continuous perimeter, viewed from outside):
${walls.map(w => `  - ${w.name}: ${w.width}x${w.height} matrix (${w.width * w.height} lights)`).join('\n')}

- Light IDs range from ${Math.min(...lightIds)} to ${Math.max(...lightIds)}
- Each light has RGBW channels (Red, Green, Blue, White) with values 0-255
- The walls connect: West → North → East → South → West (forming a rectangle)
- Top row (y=2), Middle row (y=1), Bottom row (y=0)

AVAILABLE MOTION EFFECTS:
1. "candyCane" - Alternating color stripes that move along the perimeter
   params: { color1: RGBWColor, color2: RGBWColor, stripeWidth: number (1-10), speed: number (0.1-5), direction: 1 or -1 }

2. "checkerboard" - Animated checkerboard pattern
   params: { color1: RGBWColor, color2: RGBWColor, speed: number (0.1-5) }

3. "comet" - Moving comet with tail effect
   params: { color: RGBWColor, tailLength: number (3-20), speed: number (0.1-5), direction: 1 or -1 }

4. "sparkle" - Random twinkling lights
   params: { baseColor: RGBWColor, sparkleColor: RGBWColor, density: number (0.01-0.3), speed: number (0.1-5) }

5. "wave" - Sine wave color animation
   params: { color1: RGBWColor, color2: RGBWColor, wavelength: number (5-30), speed: number (0.1-5) }

6. "rainbow" - Smooth rainbow cycle
   params: { saturation: number (0-1), brightness: number (0-1), speed: number (0.1-5) }

7. "chase" - Single light or group chasing around
   params: { color: RGBWColor, backgroundColor: RGBWColor, groupSize: number (1-10), speed: number (0.1-5), direction: 1 or -1 }

8. "breathe" - Smooth fade in/out
   params: { color: RGBWColor, minBrightness: number (0-0.5), speed: number (0.1-2) }

9. "fire" - Flickering fire effect
   params: { intensity: number (0.5-1), speed: number (0.1-3) }

10. "twinkle" - Holiday twinkle effect
    params: { baseColor: RGBWColor, twinkleColor: RGBWColor, density: number (0.05-0.4), speed: number (0.5-3) }
`;
}

export async function generateDesignFromDescription(description: string): Promise<{
  success: boolean;
  design?: GeneratedDesign;
  designId?: string;
  error?: string;
}> {
  const layoutContext = getLightLayoutContext();

  const systemPrompt = `You are an expert lighting designer for architectural RGBW LED installations.
You create beautiful, artistic light designs based on user descriptions.

${layoutContext}

INSTRUCTIONS:
1. Analyze the user's description to understand what kind of light show they want
2. Decide if this should be a STATIC design (fixed colors) or MOTION design (animated effect)
3. Generate the appropriate JSON response

For STATIC designs, create an array of ${96} RGBW color objects, one for each light (indexed by light_id 1-96).
Think about:
- Gradients across walls
- Color zones (different colors for different walls or sections)
- Patterns (stripes, alternating colors, etc.)
- Artistic composition and color harmony

For MOTION designs, select the most appropriate effect and configure its parameters.
Think about:
- Which effect best matches the description
- Appropriate colors that match the mood/theme
- Speed and intensity settings
- Direction of movement

RESPONSE FORMAT (JSON only, no markdown):
For static:
{
  "type": "static",
  "name": "Descriptive Name",
  "colors": [{"r":0,"g":0,"b":0,"w":0}, ...] // exactly 96 colors, index 0 = light_id 1, index 95 = light_id 96
}

For motion:
{
  "type": "motion",
  "name": "Descriptive Name",
  "effect": "effectName",
  "params": { ... effect parameters ... }
}

Be creative and artistic! Match the mood, theme, and energy of the user's description.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8192,
      messages: [
        {
          role: 'user',
          content: `Create a light design for: "${description}"`
        }
      ],
      system: systemPrompt
    });

    // Extract text content from response
    const textContent = response.content.find(c => c.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      throw new Error('No text response from AI');
    }

    // Parse the JSON response
    let designData: GeneratedDesign;
    try {
      // Clean up potential markdown formatting
      let jsonStr = textContent.text.trim();
      if (jsonStr.startsWith('```json')) {
        jsonStr = jsonStr.slice(7);
      }
      if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.slice(3);
      }
      if (jsonStr.endsWith('```')) {
        jsonStr = jsonStr.slice(0, -3);
      }
      designData = JSON.parse(jsonStr.trim());
    } catch {
      throw new Error('Failed to parse AI response as JSON');
    }

    // Validate the design
    if (designData.type === 'static') {
      if (!Array.isArray(designData.colors) || designData.colors.length !== 96) {
        throw new Error('Static design must have exactly 96 colors');
      }
      // Validate each color
      for (const color of designData.colors) {
        if (typeof color.r !== 'number' || typeof color.g !== 'number' ||
            typeof color.b !== 'number' || typeof color.w !== 'number') {
          throw new Error('Invalid color format');
        }
        // Clamp values
        color.r = Math.max(0, Math.min(255, Math.round(color.r)));
        color.g = Math.max(0, Math.min(255, Math.round(color.g)));
        color.b = Math.max(0, Math.min(255, Math.round(color.b)));
        color.w = Math.max(0, Math.min(255, Math.round(color.w)));
      }
    } else if (designData.type === 'motion') {
      const validEffects = ['candyCane', 'checkerboard', 'comet', 'sparkle', 'wave',
                           'rainbow', 'chase', 'breathe', 'fire', 'twinkle'];
      if (!validEffects.includes(designData.effect)) {
        throw new Error(`Invalid effect: ${designData.effect}`);
      }
    } else {
      throw new Error('Design must be either static or motion type');
    }

    // Save the design to the database
    const db = getDatabase();
    const designId = uuidv4();

    if (designData.type === 'static') {
      db.prepare(
        'INSERT INTO designs (id, name, type, data) VALUES (?, ?, ?, ?)'
      ).run(designId, designData.name, 'static', JSON.stringify({ colors: designData.colors }));
    } else {
      db.prepare(
        'INSERT INTO designs (id, name, type, data) VALUES (?, ?, ?, ?)'
      ).run(designId, designData.name, 'motion', JSON.stringify({
        effect: designData.effect,
        params: designData.params
      }));
    }

    return {
      success: true,
      design: designData,
      designId
    };

  } catch (error) {
    console.error('AI design generation error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}
