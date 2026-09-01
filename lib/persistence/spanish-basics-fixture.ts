/**
 * Original project content for the bundled Spanish Basics deck.
 *
 * This fixture is intentionally plain text. It is covered by the repository's
 * MIT license and has no media, markup, scripts, handlers, or remote links.
 */

export interface SpanishBasicsFixtureEntry {
  readonly id: string;
  readonly front: string;
  readonly back: string;
}

export const SPANISH_BASICS_FIXTURE: readonly SpanishBasicsFixtureEntry[] = [
  { id: "hola", front: "hola", back: "hello" },
  { id: "adios", front: "adiós", back: "goodbye" },
  { id: "buenos-dias", front: "buenos días", back: "good morning" },
  { id: "buenas-tardes", front: "buenas tardes", back: "good afternoon" },
  { id: "buenas-noches", front: "buenas noches", back: "good night" },
  { id: "por-favor", front: "por favor", back: "please" },
  { id: "gracias", front: "gracias", back: "thank you" },
  { id: "de-nada", front: "de nada", back: "you are welcome" },
  { id: "perdon", front: "perdón", back: "excuse me" },
  { id: "lo-siento", front: "lo siento", back: "I am sorry" },
  { id: "si", front: "sí", back: "yes" },
  { id: "no", front: "no", back: "no" },
  { id: "como-estas", front: "¿Cómo estás?", back: "How are you?" },
  { id: "estoy-bien", front: "Estoy bien", back: "I am fine" },
  { id: "me-llamo", front: "Me llamo...", back: "My name is..." },
  { id: "mucho-gusto", front: "Mucho gusto", back: "Nice to meet you" },
  { id: "que-tal", front: "¿Qué tal?", back: "How is it going?" },
  { id: "donde-esta", front: "¿Dónde está...?", back: "Where is...?" },
  { id: "cuanto-cuesta", front: "¿Cuánto cuesta?", back: "How much does it cost?" },
  { id: "no-entiendo", front: "No entiendo", back: "I do not understand" },
  { id: "puede-repetir", front: "¿Puede repetir?", back: "Can you repeat?" },
  { id: "habla-ingles", front: "¿Habla inglés?", back: "Do you speak English?" },
  { id: "necesito-ayuda", front: "Necesito ayuda", back: "I need help" },
  { id: "hasta-luego", front: "Hasta luego", back: "See you later" },
] as const;

export const SPANISH_BASICS_FIXTURE_VERSION = 1;
