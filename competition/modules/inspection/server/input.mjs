import { parse as parseHtml } from "parse5";

export function parseRuleDocument(source) {
  return parseHtml(source);
}
