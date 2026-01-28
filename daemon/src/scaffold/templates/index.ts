import { StackTemplate } from '../types';
import { reactTypescriptTemplate } from './react-typescript';
import { reactMuiWebsiteTemplate } from './react-mui-website';
import { nodeExpressTemplate } from './node-express';
import { pythonFastapiTemplate } from './python-fastapi';

export const templates: StackTemplate[] = [
  reactTypescriptTemplate,
  reactMuiWebsiteTemplate,
  nodeExpressTemplate,
  pythonFastapiTemplate,
];

export function getTemplate(id: string): StackTemplate | undefined {
  return templates.find(t => t.id === id);
}

export function getTemplatesByType(type: StackTemplate['type']): StackTemplate[] {
  return templates.filter(t => t.type === type);
}
