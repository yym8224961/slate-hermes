// 统一新建编辑器 — 图片 + 所有动态类型在同一页面切换。
// 仅用于新建；编辑流程仍使用各自的 ImageContentEditor / DynamicContentEditor。

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { DASHBOARD_CUSTOM_STARTER_TEST_DATA } from 'shared/dynamic/test-fixtures';
import { PageHeader } from '@/components/layout/PageHeader';
import type { AllContentType } from '@/features/contents/model/content-type-meta';
import { useDynamicContentForm } from '@/features/dynamic/hooks/useDynamicContentForm';
import { DynamicCreateForm } from './DynamicCreateForm';
import { ImageCreateForm } from './ImageCreateForm';

// ─── 主编辑器 ──────────────────────────────────────────────────────────────────

interface ContentCreateEditorProps {
  gid: string;
  onDone: () => void;
  onEditCreatedImage?: (contentId: string) => void;
}

export function ContentCreateEditor({ gid, onDone, onEditCreatedImage }: ContentCreateEditorProps) {
  const dynamicForm = useDynamicContentForm({ requireDashboardData: true });
  const [type, setType] = useState<AllContentType | null>(null);

  function handleTypeChange(t: AllContentType) {
    if (t === type) return;
    setType(t);
    if (t === 'image') {
      dynamicForm.reset();
    } else {
      dynamicForm.loadType(t, t === 'dashboard' ? { ...DASHBOARD_CUSTOM_STARTER_TEST_DATA } : null);
    }
  }

  function resetTypeSelection() {
    setType(null);
    dynamicForm.reset();
  }

  return (
    <div>
      <PageHeader
        onBack={onDone}
        icon={<Plus size={24} />}
        title="新建帧"
        subtitle="选择类型后填写参数，创建后追加至列表末尾，可拖拽改序。"
      />

      <div className="mt-6 fade-up fade-up-1">
        {type === 'image' ? (
          <ImageCreateForm
            gid={gid}
            type={type}
            onTypeChange={handleTypeChange}
            onResetType={resetTypeSelection}
            onDone={onDone}
            onEditCreatedImage={onEditCreatedImage}
          />
        ) : (
          <DynamicCreateForm
            gid={gid}
            type={type}
            form={dynamicForm}
            onTypeChange={handleTypeChange}
            onResetType={resetTypeSelection}
            onDone={onDone}
          />
        )}
      </div>
    </div>
  );
}
