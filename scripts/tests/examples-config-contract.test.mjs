import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";

const CONFIG_SCHEMA_PATH = path.resolve("schemas/lgtm-config.schema.json");
const EXAMPLE_CONFIG_PATHS = [
  path.resolve("examples/lgtm.yml"),
  path.resolve("examples/smoke-consumer/lgtm.yml"),
];
const SMOKE_CONSUMER_README_PATH = path.resolve("examples/smoke-consumer/README.md");

function loadSchemaValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const schema = JSON.parse(fs.readFileSync(CONFIG_SCHEMA_PATH, "utf8"));
  return ajv.compile(schema);
}

test("example configs validate against lgtm config schema", () => {
  const validate = loadSchemaValidator();

  for (const configPath of EXAMPLE_CONFIG_PATHS) {
    const config = parseYaml(fs.readFileSync(configPath, "utf8"));
    const valid = validate(config);
    if (!valid) {
      const errors = JSON.stringify(validate.errors || [], null, 2);
      assert.fail(`Schema validation failed for ${configPath}: ${errors}`);
    }
  }
});

test("full example config references checked-in prompt files", () => {
  const config = parseYaml(fs.readFileSync(path.resolve("examples/lgtm.yml"), "utf8"));
  for (const reviewer of config.reviewers || []) {
    assert.equal(typeof reviewer.prompt_file, "string");
    assert.ok(fs.existsSync(path.resolve(reviewer.prompt_file)), `${reviewer.prompt_file} must exist`);
  }
});

test("smoke-consumer template includes setup guidance", () => {
  assert.equal(fs.existsSync(SMOKE_CONSUMER_README_PATH), true);
  const readme = fs.readFileSync(SMOKE_CONSUMER_README_PATH, "utf8");
  assert.match(readme, /OPENAI_API_KEY/);
  assert.match(readme, /LGTM_GITHUB_APP_ID/);
  assert.match(readme, /LGTM_GITHUB_APP_PRIVATE_KEY/);
  assert.match(readme, /\.github\/lgtm\/prompts/);
});
