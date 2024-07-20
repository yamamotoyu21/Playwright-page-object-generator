import { chromium, devices } from "playwright";
import { minify } from "html-minifier";
import OpenAI from "openai";
import * as readline from "readline";
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import ora from "ora";
import chalk from "chalk";
import Handlebars from "handlebars";
import { v4 as uuidv4 } from "uuid";
import i18next from "i18next";
import Backend from "i18next-fs-backend";
import { glob } from "glob";
import cheerio from "cheerio";
import dotenv from "dotenv";

dotenv.config();
import { inspect } from "util";

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", inspect(error, { depth: null }));
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error(
    "Unhandled Rejection at:",
    promise,
    "reason:",
    inspect(reason, { depth: null })
  );
  process.exit(1);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface Config {
  openaiApiKey: string;
  outputDir: string;
  templateDir: string;
  language: string;
  aiModel: string;
  devices: string[];
}

class PlaywrightPageObjectGenerator {
  private openai: OpenAI;
  private config: Config;
  private templates: { [key: string]: HandlebarsTemplateDelegate } = {};

  constructor(config: Config) {
    this.config = config;
    //this.openai = new OpenAI({ apiKey: config.openaiApiKey });
    this.openai = new OpenAI({ apiKey: config.openaiApiKey });
    this.loadTemplates();
  }

  private async loadTemplates() {
    const templateFiles = await glob(`${this.config.templateDir}/**/*.hbs`);
    for (const file of templateFiles) {
      const templateContent = await fs.readFile(file, "utf-8");
      const templateName = path.basename(file, ".hbs");
      this.templates[templateName] = Handlebars.compile(templateContent);
    }
  }

  async generatePageObject(url: string, pageName: string): Promise<string> {
    const spinner = ora(i18next.t("generating")).start();

    try {
      const html = await this.loadPage(url);
      spinner.text = i18next.t("minifying");
      const minifiedHtml = this.minifyHtml(html);
      spinner.text = i18next.t("generatingInitial");
      const initialCode = this.generateInitialCode(pageName, minifiedHtml);
      spinner.text = i18next.t("refiningCode");
      const refinedCode = await this.refineCodeWithAI(
        initialCode,
        minifiedHtml
      );
      spinner.succeed(i18next.t("generationSuccess"));
      return refinedCode;
    } catch (error) {
      spinner.fail(i18next.t("generationFail"));
      throw error;
    }
  }

  private async loadPage(url: string): Promise<string> {
    const browser = await chromium.launch();
    const htmlContents: string[] = [];

    for (const deviceName of this.config.devices) {
      const context = await browser.newContext(devices[deviceName]);
      const page = await context.newPage();
      await page.goto(url);
      const html = await page.content();
      htmlContents.push(html);
      await context.close();
    }

    await browser.close();
    return htmlContents.join("\n<!-- Device Separator -->\n");
  }

  private minifyHtml(html: string): string {
    return minify(html, {
      removeComments: true,
      collapseWhitespace: true,
      minifyJS: true,
      minifyCSS: true,
    });
  }

  private generateInitialCode(pageName: string, html: string): string {
    return this.templates["pageObject"]({
      pageName,
      url: html.match(/<base href="(.+?)">/)?.[1] || "",
    });
  }

  private async refineCodeWithAI(
    initialCode: string,
    html: string
  ): Promise<string> {
    const prompt = this.templates["aiPrompt"]({
      html,
      initialCode,
    });

    const response = await this.openai.chat.completions.create({
      model: this.config.aiModel,
      messages: [{ role: "user", content: prompt }],
    });

    return response.choices[0].message?.content || initialCode;
  }

  async interactiveRefinement(code: string): Promise<string> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    let currentCode = code;
    let version = 1;

    while (true) {
      console.log(chalk.cyan(i18next.t("currentCode", { version })));
      console.log(currentCode);

      const userInput = await new Promise<string>((resolve) => {
        rl.question(chalk.yellow(i18next.t("refinementPrompt")), resolve);
      });

      if (userInput.toLowerCase() === "done") {
        rl.close();
        return currentCode;
      }

      const spinner = ora(i18next.t("refiningCode")).start();
      try {
        const refinedCode = await this.refineCodeWithAI(currentCode, userInput);
        currentCode = refinedCode;
        version++;
        spinner.succeed(i18next.t("refinementSuccess"));
        await this.saveVersion(currentCode, version);
      } catch (error) {
        spinner.fail(i18next.t("refinementFail"));
        console.error(error);
      }
    }
  }

  async saveVersion(code: string, version: number): Promise<void> {
    const versionDir = path.join(this.config.outputDir, "versions");
    await fs.mkdir(versionDir, { recursive: true });
    const filePath = path.join(versionDir);
    await fs.writeFile(filePath, code);
    console.log(chalk.green(i18next.t("versionSaved", { version, filePath })));
  }

  async generateTests(pageObjectCode: string): Promise<string> {
    const spinner = ora(i18next.t("generatingTests")).start();
    try {
      const prompt = this.templates["testPrompt"]({ pageObjectCode });
      const response = await this.openai.chat.completions.create({
        model: this.config.aiModel,
        messages: [{ role: "user", content: prompt }],
      });
      const testCode = response.choices[0].message?.content || "";
      spinner.succeed(i18next.t("testGenerationSuccess"));
      return testCode;
    } catch (error) {
      spinner.fail(i18next.t("testGenerationFail"));
      throw error;
    }
  }

  async saveToFile(code: string, fileName: string): Promise<void> {
    const filePath = path.join(this.config.outputDir, fileName);
    await fs.mkdir(this.config.outputDir, { recursive: true });
    await fs.writeFile(filePath, code);
    console.log(chalk.green(i18next.t("fileSaved", { filePath })));
  }
}

async function loadConfig(): Promise<Config> {
  const configPath = path.join(process.cwd(), "page-object-generator.json");
  try {
    const configFile = await fs.readFile(configPath, "utf-8");
    return JSON.parse(configFile);
  } catch (error) {
    console.error(chalk.red(i18next.t("configLoadFail")));
    return {
      openaiApiKey: process.env.OPENAI_API_KEY || "",
      outputDir: "./generated",
      templateDir: "./templates",
      language: "en",
      aiModel: "gpt-3.5-turbo",
      devices: ["Desktop Chrome"],
    };
  }
}

async function initializeI18n(language: string) {
  await i18next.use(Backend).init({
    lng: language,
    fallbackLng: "en",
    backend: {
      loadPath: "./locales/{{lng}}/{{ns}}.json",
    },
  });
}

async function main() {
  const config = await loadConfig();
  await initializeI18n(config.language);

  const argv = await yargs(hideBin(process.argv))
    .option("url", {
      alias: "u",
      type: "string",
      description: i18next.t("urlDescription"),
      demandOption: true,
    })
    .option("name", {
      alias: "n",
      type: "string",
      description: i18next.t("nameDescription"),
      demandOption: true,
    })
    .option("output", {
      alias: "o",
      type: "string",
      description: i18next.t("outputDescription"),
    })
    .option("generateTests", {
      alias: "t",
      type: "boolean",
      description: i18next.t("generateTestsDescription"),
      default: false,
    })
    .help().argv;

  const generator = new PlaywrightPageObjectGenerator(config);

  try {
    const initialCode = await generator.generatePageObject(
      argv.url as string,
      argv.name as string
    );
    console.log(chalk.green(i18next.t("initialCodeGenerated")));
    console.log(initialCode);

    const finalCode = await generator.interactiveRefinement(initialCode);
    console.log(chalk.green(i18next.t("finalCodeGenerated")));
    console.log(finalCode);

    if (argv.output) {
      await generator.saveToFile(finalCode, argv.output as string);
    }

    if (argv.generateTests) {
      const testCode = await generator.generateTests(finalCode);
      console.log(chalk.green(i18next.t("testCodeGenerated")));
      console.log(testCode);
      if (argv.output) {
        const testFileName = `${path.basename(
          argv.output as string,
          ".ts"
        )}.test.ts`;
        await generator.saveToFile(testCode, testFileName);
      }
    }
  } catch (error) {
    console.error(chalk.red(i18next.t("errorOccurred")), error);
    process.exit(1);
  }
}

main().catch(console.error);
