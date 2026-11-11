import { defineAsyncComponent } from 'vue';
export default {
  components: { studio: defineAsyncComponent(() => import('./GoLearningStudio.vue')) },
};
