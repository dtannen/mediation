import { registerProvider } from '../provider-registry';
import claudeProvider from './claude-provider';
import ollamaProvider from './ollama-provider';
import chatgptProvider from './chatgpt-provider';

export function registerBuiltInProviders(): void {
  registerProvider(claudeProvider);
  registerProvider(ollamaProvider);
  registerProvider(chatgptProvider);
}
