import dotenv from "dotenv";

// Load environment variables
dotenv.config();

export interface Config {
  openaiApiKey: string;
  outputDir: string;
  templateDir: string;
  language: string;
  aiModel: string;
  devices: string[];
}

function getEnvVariable(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (value === undefined) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`Environment variable ${key} is not set`);
  }
  return value;
}

export const config: Config = {
  openaiApiKey: getEnvVariable("OPENAI_API_KEY"),
  outputDir: getEnvVariable("OUTPUT_DIR", "./generated"),
  templateDir: getEnvVariable("TEMPLATE_DIR", "./templates"),
  language: getEnvVariable("LANGUAGE", "en"),
  aiModel: getEnvVariable("AI_MODEL", "gpt-3.5-turbo"),
  devices: getEnvVariable("DEVICES", "Desktop Chrome").split(","),
};

// This empty export makes the file a module
export {};
