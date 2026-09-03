/**
 * Original project content for the bundled Spanish Basics deck.
 *
 * The two local image templates are generated project assets. They exercise
 * the same inert media-reference path as APKG imports without remote content.
 */

export interface SpanishBasicsFixtureEntry {
  readonly id: string;
  readonly front: string;
  readonly back: string;
  readonly image?: SpanishBasicsFixtureImage;
}

export interface SpanishBasicsFixtureImage {
  readonly name: string;
  readonly alt: string;
  readonly pngBase64: string;
  readonly byteLength: number;
  readonly sha256: string;
}

const HOLA_IMAGE: SpanishBasicsFixtureImage = {
  name: "hola.png",
  alt: "Yellow greeting card reading HOLA",
  pngBase64: "iVBORw0KGgoAAAANSUhEUgAAAPAAAACMCAIAAADN17N/AAAFh0lEQVR42u3bW2xTdQDH8d85/3ParsW5resGiDi7JTNeEogoENgkOmHRB198MDHxknghURL11eiT0figD/qgRGPEF40x8clEvBA2IWAUMUSNIgxZBoGt3eZgl17O+fvQgoJb2db64r6fpyY7Xbf+v/33f/6ndab6uwX8X7g8BSBogKABggYIGgQNEDRA0ABBAwQNggYIGiBogKABggZBAwQNEDRA0ABBg6ABggYIGiBogKBB0ABBAwQNEDRA0CBogKABggYIGiBoEDRA0ABBAwQNggYIGiBogKABggZBAwQNEDRA0ABBg6ABggYIGiBogKBB0ABBAwQNEDRA0CBogKABggYIGiBoEDRA0ABBAwQNlHlL/P+v6+qTFJz9PH/0lcUfZuJe6za38XY30e74V8vKFsbDyePh2LfF4d0KZqp56DlH7pr7/fSO0u3cD4+EkyeomaBrwLRs9dNPOX6DJIU5m89KciJJE9tkkpu86x4tHH8zGPn6v3hcSVIouSbVE06+w1gQdNVP37UP+m1PSArP/148+W4wdki2IEmObxrXeW2PuYmOyA0vFqKp4tBHNXxcJ97mLuuUDYunPvZWPWBSPYU/CJo1dJVzZNMGv+1xSUFmb+7H7cHowXLNkmwhGD2QO/xkkP1Gkn/9drfxtlq+kFq2SgrGvy+e/kSyTmy5W38zI0LQ1UySrt/+rOTY6aH8by/LFmc5xhbzv75kZ05LTqTjOTm1erZd03K3pGB4t82NhBM/STKpHsaEoKuYnpPdTmy5pMLgLoW5OY8LZwqDH0hyYitNsqs2Y9awxom2KJgOMvskBSN7JJnUFjmGcSHoxa83ykuLTF/lI4ORPaX5u3yXGqw3tkkKMn0KZ8o3FDp+o2m4lXEh6MU+cVfdKCmcHKg0PZcn6Vw4OXDxLlU/cMw0d0sqDn9RXtfks+GfRySV1iEEjUWJNEmyueH5HGtzI5LkN9XgnaG5SyZu85lw/PAlbwKSSW6WG2XbDjKtvXWtvQs7JzRxSQqm53V0MCXJ8RK12n4Ohr+Uwr9/fabfb39GJm6aNgaZvQS91NniOZs7W+mNLNFx+V2CScerl6mbX4ZxSbY4We3OSiRpGtZJ8lbcZ1rvvfRnpdx7CBoKs/vnc+n7EvlRefVOtGVeIUZTkmwhW/X03FPe+zPxWbc0TOMGx1tmi+cJGgt8DZz7xcTb3ERabqy021DhNM5NpCWFEz9XHfQ2SYWT7xUHd13+mvEbYus/leu7zXcEZz7jpBALE4weKF/iTm25QoWpO+V4ksLRg1UNVSLtJtolhZn+WVZNhfFw4ogkb2lfYSHoxQad3WdnTkvyVz8sNzZ3zjF/9UOS7PSpILu/uum5V5KdHgynZv9gXWn17DascSJJgsZCTyTD/LHXJevEVkY6ny/Nwf9aO/uRzhec2AopzB977Z/7Eou40m5aekobGnO+xjJ9Fz58dxdBY+HL6LHvCid2SjLN3dG1O03TBjn+xZRN08bo2rdNcrNkCwNvheOHqpqeG9aV5t0KFyZtfrS0TC+lz0khFqw49KHNj/jpHW6iI3LTqwpzNpeR5ESbS9c4bH6sMPBG6cLHXBsXsYqf8Zg5cM/F7Wc7cyY8f7TSQiiz162/xV3W6dStstNDBI2FL6aHvwqy+73WXrdxvZtIO9FmyZa/sTJ6sMI3Vi7M5Z7jXWkUTJ1p7pIUZPuv8Mdk+vz005JjUj3FwfeX4HA4U/3dRAnW0ABBAwQNEDQIGiBogKABggYIGgQNEDRA0ABBAwQNggYIGiBogKABggZBAwQNEDRA0ABBg6ABggYIGiBogKBB0ABBAwQNEDRA0CBogKABggYIGgQNEDRA0ABBAwQNggYIGiBogKABggZBAwQNEDRQW38B0wOea93Dl04AAAAASUVORK5CYII=",
  byteLength: 1472,
  sha256: "8cadad834010c5ed24d2e72f6fa7fac8554d171496e111b606e591b0bbfec3eb",
};

export const SPANISH_BASICS_FIXTURE: readonly SpanishBasicsFixtureEntry[] = [
  { id: "hola", front: "hola", back: "hello", image: HOLA_IMAGE },
  { id: "adios", front: "adiós", back: "goodbye" },
  { id: "buenos-dias", front: "buenos días", back: "good morning", image: HOLA_IMAGE },
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

export const SPANISH_BASICS_FIXTURE_VERSION = 2;
