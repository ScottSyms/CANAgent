import { describe, expect, it } from 'vitest';
import { COMMUNITY_SUMMARY_SCHEMA, DOC_EXTRACTION_SCHEMA, RELATION_TYPING_SCHEMA } from './graphJsonSchemas';

describe('graph JSON schemas', () => {
  it('DOC_EXTRACTION_SCHEMA matches DocExtraction: entities/relations arrays of the expected shape', () => {
    expect(DOC_EXTRACTION_SCHEMA.name).toBe('doc_extraction');
    expect(DOC_EXTRACTION_SCHEMA.schema.required).toEqual(['entities', 'relations']);
    const entityItem = DOC_EXTRACTION_SCHEMA.schema.properties.entities.items;
    expect(entityItem.required).toEqual(['label', 'type', 'summary', 'evidence']);
    const relationItem = DOC_EXTRACTION_SCHEMA.schema.properties.relations.items;
    expect(relationItem.required).toEqual(['from', 'to', 'relation', 'evidence']);
  });

  it('RELATION_TYPING_SCHEMA matches typeOneRelation\'s {relation: string} shape', () => {
    expect(RELATION_TYPING_SCHEMA.schema.required).toEqual(['relation']);
    expect(RELATION_TYPING_SCHEMA.schema.properties.relation).toEqual({ type: 'string' });
  });

  it('COMMUNITY_SUMMARY_SCHEMA matches summarizeOneCommunity\'s {title, summary, evidence} shape', () => {
    expect(COMMUNITY_SUMMARY_SCHEMA.schema.required).toEqual(['title', 'summary', 'evidence']);
    expect(Object.keys(COMMUNITY_SUMMARY_SCHEMA.schema.properties)).toEqual(['title', 'summary', 'evidence']);
  });

  it('every schema has a unique, non-empty name', () => {
    const names = [DOC_EXTRACTION_SCHEMA.name, RELATION_TYPING_SCHEMA.name, COMMUNITY_SUMMARY_SCHEMA.name];
    expect(names.every((n) => n.length > 0)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });
});
