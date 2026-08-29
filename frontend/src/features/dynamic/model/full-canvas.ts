import { dashboardTemplateUsesFullCanvas, type DynamicConfigT } from 'shared';

export function dynamicConfigUsesFullCanvas(config: DynamicConfigT | null | undefined): boolean {
  return (
    config?.type === 'dashboard' &&
    config.template.kind === 'custom' &&
    dashboardTemplateUsesFullCanvas(config.template.template)
  );
}
