import * as yaml from 'js-yaml';
import { parse } from '@ctrl/golang-template'; // Assuming this import structure is correct

/**
 * Reads a YAML string, replaces template values using @ctrl/golang-template,
 * and then parses the resulting final YAML into a structured object.
 *
 * @param rawYamlString The input string containing YAML and potential template placeholders.
 * @param replacements A map of key-value pairs to use for template replacements (e.g., { "key": "value" }).
 * @returns A promise that resolves with the parsed YAML context object.
 */
export async function processYamlTemplate(rawYamlString: string, replacements: Record<string, any>): Promise<any> {
    // 1. Replace template values using @ctrl/golang-template
    let processedString: string;

    try {
        processedString = await parse(rawYamlString, replacements);
    } catch (error) {
        console.error("Error rendering YAML template:", error);
        throw new Error(`Failed to render template: ${(error as Error).message}`);
    }

    // 2. Parse the resulting final YAML string
    try {
        const context = yaml.load(processedString) as any;
        return context;
    } catch (error) {
        console.error("Error parsing final YAML content:", error);
        throw new Error(`Failed to parse resultant YAML: ${(error as Error).message}`);
    }
}
