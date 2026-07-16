#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourcePath = resolve(root, "extensions/computer-use.ts");
const outputPath = resolve(root, "docs/content/docs/reference/agent/tools.mdx");
const check = process.argv.includes("--check");
const sourceText = readFileSync(sourcePath, "utf8");
const source = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const values = new Map();

function keyOf(name) {
	if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
	throw new Error(`Unsupported property name: ${name.getText(source)}`);
}

function optional(schema) {
	return { __optional: true, schema };
}

function unwrap(value) {
	return value?.__optional ? value.schema : value;
}

function evaluate(node) {
	if (!node) return undefined;
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
	if (ts.isNumericLiteral(node)) return Number(node.text);
	if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
	if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
	if (node.kind === ts.SyntaxKind.NullKeyword) return null;
	if (ts.isIdentifier(node)) return values.get(node.text);
	if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return evaluate(node.expression);
	if (ts.isArrayLiteralExpression(node)) return node.elements.map(evaluate);
	if (ts.isObjectLiteralExpression(node)) {
		const result = {};
		for (const property of node.properties) {
			if (ts.isPropertyAssignment(property)) result[keyOf(property.name)] = evaluate(property.initializer);
			else if (ts.isShorthandPropertyAssignment(property)) result[property.name.text] = values.get(property.name.text);
			else if (ts.isSpreadAssignment(property)) Object.assign(result, evaluate(property.expression));
		}
		return result;
	}
	if (!ts.isCallExpression(node)) return undefined;

	if (ts.isIdentifier(node.expression) && node.expression.text === "defineTool") return evaluate(node.arguments[0]);
	if (!ts.isPropertyAccessExpression(node.expression) || !ts.isIdentifier(node.expression.expression) || node.expression.expression.text !== "Type") return undefined;

	const method = node.expression.name.text;
	const args = node.arguments.map(evaluate);
	const options = args.at(-1) && !Array.isArray(args.at(-1)) && typeof args.at(-1) === "object" ? args.at(-1) : {};
	switch (method) {
		case "String": return { type: "string", ...options };
		case "Number": return { type: "number", ...options };
		case "Boolean": return { type: "boolean", ...options };
		case "Literal": return { type: typeof args[0], const: args[0], ...(args[1] ?? {}) };
		case "Optional": return optional(unwrap(args[0]));
		case "Union": return { anyOf: args[0].map(unwrap), ...(args[1] ?? {}) };
		case "Array": return { type: "array", items: unwrap(args[0]), ...(args[1] ?? {}) };
		case "Object": {
			const properties = {};
			const required = [];
			for (const [name, value] of Object.entries(args[0] ?? {})) {
				properties[name] = unwrap(value);
				if (!value?.__optional) required.push(name);
			}
			return { type: "object", ...(required.length ? { required } : {}), properties, ...(args[1] ?? {}) };
		}
		default: throw new Error(`Unsupported Type.${method} in ${sourcePath}`);
	}
}

for (const statement of source.statements) {
	if (!ts.isVariableStatement(statement)) continue;
	for (const declaration of statement.declarationList.declarations) {
		if (ts.isIdentifier(declaration.name)) values.set(declaration.name.text, evaluate(declaration.initializer));
	}
}

const tools = [...values.entries()]
	.filter(([name, value]) => name.endsWith("Tool") && value?.name && value?.parameters)
	.map(([, value]) => value);

function code(value) {
	return `\`${String(value).replaceAll("|", "\\|")}\``;
}

function typeName(schema) {
	if (!schema) return "unknown";
	if (schema.const !== undefined) return code(schema.const);
	if (schema.anyOf) {
		const literals = schema.anyOf.every((item) => item.const !== undefined);
		return literals ? schema.anyOf.map((item) => code(item.const)).join(" \\| ") : "union";
	}
	if (schema.type === "array") return `array of ${typeName(schema.items)}`;
	if (schema.type === "object" && Object.keys(schema.properties ?? {}).length) {
		const fields = Object.entries(schema.properties).map(([name, property]) => `${name}: ${typeName(property)}`);
		return `object (${fields.join(", ")})`;
	}
	return code(schema.type ?? "unknown");
}

function constraints(schema) {
	const entries = ["default", "minimum", "maximum", "minItems", "maxItems"]
		.filter((name) => schema[name] !== undefined)
		.map((name) => `${name}: ${code(schema[name])}`);
	return entries.length ? ` ${entries.join(", ")}.` : "";
}

function parameterRows(schema, prefix = "") {
	const rows = [];
	for (const [name, property] of Object.entries(schema?.properties ?? {})) {
		const path = prefix ? `${prefix}.${name}` : name;
		const required = schema.required?.includes(name) ? "yes" : "no";
		rows.push(`| ${code(path)} | ${typeName(property)} | ${required} | ${(property.description ?? "—").replaceAll("|", "\\|")}${constraints(property)} |`);
		if (property.type === "object") rows.push(...parameterRows(property, path));
	}
	return rows;
}

function actionRows(schema) {
	const action = schema?.properties?.actions?.items;
	if (!action?.anyOf) return [];
	const lines = ["", "#### action variants", "", "| action | fields |", "| --- | --- |"];
	for (const variant of action.anyOf) {
		const name = variant.properties?.action?.const ?? "unknown";
		const fields = Object.entries(variant.properties ?? {})
			.filter(([field]) => field !== "action")
			.map(([field, property]) => {
				const required = variant.required?.includes(field) ? "required" : "optional";
				return `${code(field)}: ${typeName(property)} (${required})${constraints(property)}`;
			})
			.join("; ") || "—";
		lines.push(`| ${code(name)} | ${fields} |`);
	}
	return lines;
}

const lines = [
	"---",
	"title: 'Tool schema reference'",
	"description: 'Exact Pi tool descriptions, guidance, parameters, enums, and constraints extracted from source.'",
	"---",
	"",
	"{/* This file is generated by scripts/docs-generators/generate-tool-reference.mjs. Do not edit it directly. */}",
	"",
	"This reference is generated from the registered Pi tool definitions in [`extensions/computer-use.ts`](https://github.com/injaneity/pi-computer-use/blob/main/extensions/computer-use.ts). Tool descriptions, agent guidance, parameter descriptions, enum values, and array bounds therefore stay aligned with the interface shipped to agents.",
	"",
];

for (const tool of tools) {
	lines.push(`## ${code(tool.name)}`, "", tool.description, "");
	if (tool.promptSnippet || tool.promptGuidelines?.length) {
		lines.push("### agent guidance", "");
		if (tool.promptSnippet) lines.push(tool.promptSnippet, "");
		for (const guideline of tool.promptGuidelines ?? []) lines.push(`- ${guideline}`);
		if (tool.promptGuidelines?.length) lines.push("");
	}
	lines.push("### parameters", "", "| parameter | type | required | description and constraints |", "| --- | --- | --- | --- |", ...parameterRows(tool.parameters));
	lines.push(...actionRows(tool.parameters), "");
}

lines.push('<details className="reference-provenance">', '  <summary>source provenance</summary>', '  <p>Generated by statically evaluating registered <code>defineTool</code> declarations in <a href="https://github.com/injaneity/pi-computer-use/blob/main/extensions/computer-use.ts"><code>extensions/computer-use.ts</code></a>. Schema drift fails <code>npm run docs:check</code>.</p>', '</details>', '');

const generated = `${lines.join("\n").trimEnd()}\n`;
const current = (() => { try { return readFileSync(outputPath, "utf8"); } catch { return ""; } })();

if (check) {
	if (current !== generated) {
		console.error("Generated tool reference is out of date. Run `npm run docs:generate`.");
		process.exit(1);
	}
	console.log("Generated tool reference is up to date.");
} else {
	writeFileSync(outputPath, generated);
	console.log(`Generated ${tools.length} tool references at ${outputPath.slice(root.length + 1)}.`);
}
