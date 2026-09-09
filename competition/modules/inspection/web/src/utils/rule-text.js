export function ruleDocumentLabel(document) {
  return document === "formula-technical" ? "차량기술규정" : "경기진행규정";
}

const HTML_TAGS = new Set([
  "br", "div", "figcaption", "figure", "h2", "h3", "hr", "li", "ol", "p", "span",
  "strong", "table", "tbody", "td", "th", "thead", "tr", "u", "ul",
]);
const DROP_TAGS = new Set([
  "annotation", "annotation-xml", "audio", "button", "embed", "iframe", "object", "script",
  "source", "style", "svg", "template", "video",
]);
const MATHML_NAMESPACE = "http://www.w3.org/1998/Math/MathML";

function sanitizeElement(element) {
  const tag = element.localName.toLowerCase();
  if (tag === "img") {
    element.replaceWith(element.ownerDocument.createTextNode(element.getAttribute("alt") || ""));
    return;
  }
  if (DROP_TAGS.has(tag)) {
    element.remove();
    return;
  }
  const isMathMl = element.namespaceURI === MATHML_NAMESPACE;
  if (!isMathMl && !HTML_TAGS.has(tag)) {
    element.replaceWith(...element.childNodes);
    return;
  }

  const attributes = {};
  if (isMathMl) {
    for (const name of ["display", "form", "mathvariant", "stretchy", "width"]) {
      if (element.hasAttribute(name)) attributes[name] = element.getAttribute(name);
    }
  } else if (["td", "th"].includes(tag)) {
    for (const name of ["colspan", "rowspan"]) {
      const value = element.getAttribute(name);
      if (/^\d{1,2}$/.test(value || "")) attributes[name] = value;
    }
  } else if (tag === "ol") {
    const start = element.getAttribute("start");
    const type = element.getAttribute("type");
    if (/^\d{1,4}$/.test(start || "")) attributes.start = start;
    if (/^[1AaIi]$/.test(type || "")) attributes.type = type;
  }
  for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
}

export function sanitizeRuleContentHtml(value) {
  if (typeof value !== "string" || !value.trim() || typeof DOMParser === "undefined") return "";
  const parsed = new DOMParser().parseFromString(value, "text/html");
  for (const element of [...parsed.body.querySelectorAll("*")]) sanitizeElement(element);
  return parsed.body.innerHTML.trim();
}
