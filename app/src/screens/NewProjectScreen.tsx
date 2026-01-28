import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Switch,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { wsService } from '../services/websocket';
import { StackTemplate, ProjectConfig, ScaffoldProgress, ScaffoldResult } from '../types';

interface NewProjectScreenProps {
  onBack: () => void;
  onComplete: (projectPath: string) => void;
}

type WizardStep = 'details' | 'template' | 'options' | 'creating' | 'done';

export function NewProjectScreen({ onBack, onComplete }: NewProjectScreenProps) {
  const [step, setStep] = useState<WizardStep>('details');
  const [templates, setTemplates] = useState<StackTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [projectName, setProjectName] = useState('');
  const [projectDescription, setProjectDescription] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [location, setLocation] = useState('~/projects');
  const [initGit, setInitGit] = useState(true);

  // Progress state
  const [progress, setProgress] = useState<ScaffoldProgress | null>(null);
  const [result, setResult] = useState<ScaffoldResult | null>(null);

  // Load templates on mount
  useEffect(() => {
    loadTemplates();
  }, []);

  const loadTemplates = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await wsService.sendRequest('get_scaffold_templates', {});
      if (response.success && response.payload) {
        const payload = response.payload as { templates: StackTemplate[] };
        setTemplates(payload.templates);
      } else {
        setError(response.error || 'Failed to load templates');
      }
    } catch (err) {
      setError('Failed to connect to server');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = useCallback(async () => {
    if (!projectName || !selectedTemplate) {
      Alert.alert('Missing Info', 'Please enter a project name and select a template');
      return;
    }

    setStep('creating');
    setProgress({ step: 'Starting...', progress: 0, complete: false });

    try {
      const config: ProjectConfig = {
        name: projectName,
        description: projectDescription || `A ${templates.find(t => t.id === selectedTemplate)?.name} project`,
        location: location.startsWith('~') ? location.replace('~', '/home/' + (process.env.USER || 'user')) : location,
        stackId: selectedTemplate,
        options: {
          initGit,
          includeDocker: false,
          includeCI: false,
          includeLinter: true,
        },
      };

      // Listen for progress updates
      const progressHandler = (msg: { type: string; payload?: unknown }) => {
        if (msg.type === 'scaffold_progress' && msg.payload) {
          setProgress(msg.payload as ScaffoldProgress);
        }
      };
      const unsubscribe = wsService.onMessage(progressHandler);

      const response = await wsService.sendRequest('scaffold_create', config);

      unsubscribe();

      if (response.success && response.payload) {
        const scaffoldResult = response.payload as ScaffoldResult;
        setResult(scaffoldResult);
        setStep('done');
      } else {
        setProgress({
          step: 'Error',
          detail: response.error,
          progress: 0,
          complete: true,
          error: response.error,
        });
      }
    } catch (err) {
      setProgress({
        step: 'Error',
        detail: err instanceof Error ? err.message : 'Unknown error',
        progress: 0,
        complete: true,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }, [projectName, projectDescription, selectedTemplate, location, initGit, templates]);

  const renderStepIndicator = () => {
    const steps = ['Details', 'Template', 'Options'];
    const currentIndex = step === 'details' ? 0 : step === 'template' ? 1 : step === 'options' ? 2 : 2;

    return (
      <View style={styles.stepIndicator}>
        {steps.map((s, i) => (
          <View key={s} style={styles.stepItem}>
            <View style={[styles.stepDot, i <= currentIndex && styles.stepDotActive]}>
              <Text style={[styles.stepDotText, i <= currentIndex && styles.stepDotTextActive]}>
                {i + 1}
              </Text>
            </View>
            <Text style={[styles.stepLabel, i <= currentIndex && styles.stepLabelActive]}>
              {s}
            </Text>
          </View>
        ))}
      </View>
    );
  };

  const renderDetailsStep = () => (
    <View style={styles.stepContent}>
      <Text style={styles.stepTitle}>Project Details</Text>
      <Text style={styles.stepDescription}>What do you want to build?</Text>

      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>Project Name</Text>
        <TextInput
          style={styles.input}
          value={projectName}
          onChangeText={setProjectName}
          placeholder="my-awesome-project"
          placeholderTextColor="#6b7280"
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>Description (optional)</Text>
        <TextInput
          style={[styles.input, styles.inputMultiline]}
          value={projectDescription}
          onChangeText={setProjectDescription}
          placeholder="A brief description of your project..."
          placeholderTextColor="#6b7280"
          multiline
          numberOfLines={3}
        />
      </View>

      <View style={styles.buttonRow}>
        <TouchableOpacity style={styles.buttonSecondary} onPress={onBack}>
          <Text style={styles.buttonSecondaryText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.buttonPrimary, !projectName && styles.buttonDisabled]}
          onPress={() => setStep('template')}
          disabled={!projectName}
        >
          <Text style={styles.buttonPrimaryText}>Next</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderTemplateStep = () => (
    <View style={styles.stepContent}>
      <Text style={styles.stepTitle}>Choose a Template</Text>
      <Text style={styles.stepDescription}>Select the tech stack for your project</Text>

      {loading ? (
        <ActivityIndicator size="large" color="#3b82f6" style={styles.loader} />
      ) : error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={loadTemplates}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView style={styles.templateList}>
          {templates.map((template) => (
            <TouchableOpacity
              key={template.id}
              style={[
                styles.templateCard,
                selectedTemplate === template.id && styles.templateCardSelected,
              ]}
              onPress={() => setSelectedTemplate(template.id)}
            >
              <View style={styles.templateHeader}>
                <Text style={styles.templateIcon}>{template.icon}</Text>
                <View style={styles.templateInfo}>
                  <Text style={styles.templateName}>{template.name}</Text>
                  <Text style={styles.templateType}>{template.type}</Text>
                </View>
                {selectedTemplate === template.id && (
                  <Text style={styles.checkmark}>✓</Text>
                )}
              </View>
              <Text style={styles.templateDescription}>{template.description}</Text>
              <View style={styles.tagRow}>
                {template.tags.slice(0, 4).map((tag) => (
                  <View key={tag} style={styles.tag}>
                    <Text style={styles.tagText}>{tag}</Text>
                  </View>
                ))}
              </View>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      <View style={styles.buttonRow}>
        <TouchableOpacity style={styles.buttonSecondary} onPress={() => setStep('details')}>
          <Text style={styles.buttonSecondaryText}>Back</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.buttonPrimary, !selectedTemplate && styles.buttonDisabled]}
          onPress={() => setStep('options')}
          disabled={!selectedTemplate}
        >
          <Text style={styles.buttonPrimaryText}>Next</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderOptionsStep = () => (
    <View style={styles.stepContent}>
      <Text style={styles.stepTitle}>Project Options</Text>
      <Text style={styles.stepDescription}>Configure your project setup</Text>

      <View style={styles.inputGroup}>
        <Text style={styles.inputLabel}>Location</Text>
        <TextInput
          style={styles.input}
          value={location}
          onChangeText={setLocation}
          placeholder="~/projects"
          placeholderTextColor="#6b7280"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Text style={styles.inputHint}>
          Project will be created at: {location}/{projectName.toLowerCase().replace(/[^a-z0-9-]/g, '-')}
        </Text>
      </View>

      <View style={styles.optionRow}>
        <View style={styles.optionInfo}>
          <Text style={styles.optionLabel}>Initialize Git Repository</Text>
          <Text style={styles.optionDescription}>Create a git repo with initial commit</Text>
        </View>
        <Switch
          value={initGit}
          onValueChange={setInitGit}
          trackColor={{ false: '#374151', true: '#3b82f6' }}
        />
      </View>

      <View style={styles.summaryBox}>
        <Text style={styles.summaryTitle}>Summary</Text>
        <View style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>Name:</Text>
          <Text style={styles.summaryValue}>{projectName}</Text>
        </View>
        <View style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>Template:</Text>
          <Text style={styles.summaryValue}>
            {templates.find(t => t.id === selectedTemplate)?.name}
          </Text>
        </View>
        <View style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>Git:</Text>
          <Text style={styles.summaryValue}>{initGit ? 'Yes' : 'No'}</Text>
        </View>
      </View>

      <View style={styles.buttonRow}>
        <TouchableOpacity style={styles.buttonSecondary} onPress={() => setStep('template')}>
          <Text style={styles.buttonSecondaryText}>Back</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.buttonPrimary} onPress={handleCreate}>
          <Text style={styles.buttonPrimaryText}>Create Project</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderCreatingStep = () => (
    <View style={styles.creatingContainer}>
      <ActivityIndicator size="large" color="#3b82f6" />
      <Text style={styles.creatingTitle}>
        {progress?.error ? 'Error' : 'Creating Project...'}
      </Text>
      <Text style={styles.creatingStep}>{progress?.step}</Text>
      {progress?.detail && (
        <Text style={styles.creatingDetail}>{progress.detail}</Text>
      )}
      {!progress?.error && (
        <View style={styles.progressBar}>
          <View style={[styles.progressFill, { width: `${progress?.progress || 0}%` }]} />
        </View>
      )}
      {progress?.error && (
        <TouchableOpacity style={styles.buttonPrimary} onPress={() => setStep('options')}>
          <Text style={styles.buttonPrimaryText}>Try Again</Text>
        </TouchableOpacity>
      )}
    </View>
  );

  const renderDoneStep = () => (
    <View style={styles.doneContainer}>
      <Text style={styles.doneIcon}>🎉</Text>
      <Text style={styles.doneTitle}>Project Created!</Text>
      <Text style={styles.donePath}>{result?.projectPath}</Text>

      <View style={styles.filesCreated}>
        <Text style={styles.filesTitle}>Files created:</Text>
        {result?.filesCreated.slice(0, 8).map((file) => (
          <Text key={file} style={styles.fileName}>• {file}</Text>
        ))}
        {(result?.filesCreated.length || 0) > 8 && (
          <Text style={styles.filesMore}>
            +{(result?.filesCreated.length || 0) - 8} more files
          </Text>
        )}
      </View>

      <View style={styles.buttonRow}>
        <TouchableOpacity style={styles.buttonSecondary} onPress={onBack}>
          <Text style={styles.buttonSecondaryText}>Done</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.buttonPrimary}
          onPress={() => result && onComplete(result.projectPath)}
        >
          <Text style={styles.buttonPrimaryText}>Open in Claude</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backButton}>
          <Text style={styles.backButtonText}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>New Project</Text>
        <View style={styles.placeholder} />
      </View>

      {step !== 'creating' && step !== 'done' && renderStepIndicator()}

      <ScrollView style={styles.content} contentContainerStyle={styles.contentContainer}>
        {step === 'details' && renderDetailsStep()}
        {step === 'template' && renderTemplateStep()}
        {step === 'options' && renderOptionsStep()}
        {step === 'creating' && renderCreatingStep()}
        {step === 'done' && renderDoneStep()}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#111827',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: '#1f2937',
    borderBottomWidth: 1,
    borderBottomColor: '#374151',
  },
  backButton: {
    paddingHorizontal: 4,
    paddingVertical: 4,
    minWidth: 60,
  },
  backButtonText: {
    color: '#3b82f6',
    fontSize: 17,
  },
  headerTitle: {
    color: '#f3f4f6',
    fontSize: 17,
    fontWeight: '600',
  },
  placeholder: {
    minWidth: 60,
  },
  stepIndicator: {
    flexDirection: 'row',
    justifyContent: 'center',
    paddingVertical: 16,
    backgroundColor: '#1f2937',
    borderBottomWidth: 1,
    borderBottomColor: '#374151',
  },
  stepItem: {
    alignItems: 'center',
    marginHorizontal: 20,
  },
  stepDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#374151',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 4,
  },
  stepDotActive: {
    backgroundColor: '#3b82f6',
  },
  stepDotText: {
    color: '#6b7280',
    fontSize: 14,
    fontWeight: '600',
  },
  stepDotTextActive: {
    color: '#ffffff',
  },
  stepLabel: {
    color: '#6b7280',
    fontSize: 12,
  },
  stepLabelActive: {
    color: '#f3f4f6',
  },
  content: {
    flex: 1,
  },
  contentContainer: {
    padding: 16,
    paddingBottom: 40,
  },
  stepContent: {
    flex: 1,
  },
  stepTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#f3f4f6',
    marginBottom: 4,
  },
  stepDescription: {
    fontSize: 14,
    color: '#9ca3af',
    marginBottom: 24,
  },
  inputGroup: {
    marginBottom: 20,
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#f3f4f6',
    marginBottom: 8,
  },
  input: {
    backgroundColor: '#1f2937',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: '#f3f4f6',
    borderWidth: 1,
    borderColor: '#374151',
  },
  inputMultiline: {
    minHeight: 80,
    textAlignVertical: 'top',
  },
  inputHint: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 6,
  },
  buttonRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 24,
  },
  buttonPrimary: {
    backgroundColor: '#3b82f6',
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 8,
    flex: 1,
    marginLeft: 8,
    alignItems: 'center',
  },
  buttonPrimaryText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  buttonSecondary: {
    backgroundColor: '#374151',
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 8,
    flex: 1,
    marginRight: 8,
    alignItems: 'center',
  },
  buttonSecondaryText: {
    color: '#f3f4f6',
    fontSize: 16,
    fontWeight: '600',
  },
  buttonDisabled: {
    backgroundColor: '#1f2937',
    opacity: 0.6,
  },
  loader: {
    marginVertical: 40,
  },
  errorBox: {
    backgroundColor: '#7f1d1d',
    padding: 16,
    borderRadius: 8,
    alignItems: 'center',
  },
  errorText: {
    color: '#fecaca',
    fontSize: 14,
    marginBottom: 12,
  },
  retryButton: {
    backgroundColor: '#dc2626',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 6,
  },
  retryButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '500',
  },
  templateList: {
    flex: 1,
    marginBottom: 16,
  },
  templateCard: {
    backgroundColor: '#1f2937',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  templateCardSelected: {
    borderColor: '#3b82f6',
  },
  templateHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  templateIcon: {
    fontSize: 28,
    marginRight: 12,
  },
  templateInfo: {
    flex: 1,
  },
  templateName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#f3f4f6',
  },
  templateType: {
    fontSize: 12,
    color: '#9ca3af',
    textTransform: 'capitalize',
  },
  checkmark: {
    fontSize: 20,
    color: '#3b82f6',
    fontWeight: 'bold',
  },
  templateDescription: {
    fontSize: 13,
    color: '#9ca3af',
    marginBottom: 10,
  },
  tagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  tag: {
    backgroundColor: '#374151',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    marginRight: 6,
    marginTop: 4,
  },
  tagText: {
    fontSize: 11,
    color: '#9ca3af',
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#1f2937',
    padding: 16,
    borderRadius: 8,
    marginBottom: 12,
  },
  optionInfo: {
    flex: 1,
    marginRight: 12,
  },
  optionLabel: {
    fontSize: 15,
    fontWeight: '500',
    color: '#f3f4f6',
  },
  optionDescription: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 2,
  },
  summaryBox: {
    backgroundColor: '#1f2937',
    borderRadius: 8,
    padding: 16,
    marginTop: 16,
  },
  summaryTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#9ca3af',
    marginBottom: 12,
    textTransform: 'uppercase',
  },
  summaryRow: {
    flexDirection: 'row',
    marginBottom: 6,
  },
  summaryLabel: {
    fontSize: 14,
    color: '#6b7280',
    width: 80,
  },
  summaryValue: {
    fontSize: 14,
    color: '#f3f4f6',
    flex: 1,
  },
  creatingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
    paddingVertical: 60,
  },
  creatingTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: '#f3f4f6',
    marginTop: 20,
    marginBottom: 8,
  },
  creatingStep: {
    fontSize: 16,
    color: '#9ca3af',
    marginBottom: 4,
  },
  creatingDetail: {
    fontSize: 13,
    color: '#6b7280',
    marginBottom: 20,
  },
  progressBar: {
    width: '100%',
    height: 6,
    backgroundColor: '#374151',
    borderRadius: 3,
    marginTop: 16,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#3b82f6',
    borderRadius: 3,
  },
  doneContainer: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 40,
  },
  doneIcon: {
    fontSize: 64,
    marginBottom: 16,
  },
  doneTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#f3f4f6',
    marginBottom: 8,
  },
  donePath: {
    fontSize: 14,
    color: '#3b82f6',
    fontFamily: 'monospace',
    marginBottom: 24,
  },
  filesCreated: {
    backgroundColor: '#1f2937',
    borderRadius: 8,
    padding: 16,
    width: '100%',
    marginBottom: 24,
  },
  filesTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#9ca3af',
    marginBottom: 8,
  },
  fileName: {
    fontSize: 13,
    color: '#d1d5db',
    fontFamily: 'monospace',
    marginVertical: 2,
  },
  filesMore: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 6,
    fontStyle: 'italic',
  },
});
