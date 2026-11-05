import { describe, expect, it } from 'vitest';
import { featureLabel } from '../auditFeatures';

describe('featureLabel', () => {
  it.each(['insights', 'agents', 'assistant', 'ui_builder'])('labels removed feature %s', (id) => {
    expect(featureLabel(id)).toBe('Removed feature');
  });

  it('labels the live features in plain words', () => {
    expect(featureLabel('data_import')).toBe('Data import');
    expect(featureLabel('data_export')).toBe('Data export');
    expect(featureLabel('cross_insights_explain')).toBe('Insight explanations');
  });

  it('labels the folder features', () => {
    expect(featureLabel('folder_summary')).toBe('Folder summaries');
    expect(featureLabel('folder_index')).toBe('Folder question index');
    expect(featureLabel('folder_report')).toBe('Folder reports');
    expect(featureLabel('folder_ask')).toBe('Folder questions');
    expect(featureLabel('folder_export')).toBe('Folder export');
  });

  it('falls back to the raw id for unknown ids, including inherited object keys', () => {
    expect(featureLabel('brand_new_feature')).toBe('brand_new_feature');
    expect(featureLabel('toString')).toBe('toString');
  });
});
