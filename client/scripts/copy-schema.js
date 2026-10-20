/**
 * Copies the server's schema into the package (`schema.graphql`), with LF line
 * endings, so a consumer can generate types for their own operations against
 * exactly the schema this client version was built from.
 */
const { readFileSync, writeFileSync } = require('fs');
const { join } = require('path');

const source = join(__dirname, '..', '..', 'graphql-server', 'src', 'schema.graphql');
const text = readFileSync(source, 'utf8').replace(/\r\n/g, '\n').replace(/\s+$/u, '') + '\n';
writeFileSync(join(__dirname, '..', 'schema.graphql'), text);
