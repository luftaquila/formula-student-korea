<script setup>
defineProps({
  connected: Boolean,
  greenActive: Boolean,
  lightColor: {
    type: String,
    default: 'grey'
  }
})

const emit = defineEmits(['green', 'red', 'off'])
</script>

<template>
  <article>
    <h2><i class="fa fw fa-traffic-light"></i>신호등</h2>
    <div>
      <table class="buttons">
        <tr>
          <td>
            <span
              class="btn green"
              :class="{ disabled: !connected || greenActive }"
              @click="emit('green')"
            >
              <i class="fa fw fa-lightbulb"></i>녹색등
            </span>
          </td>
          <td>
            <span
              class="btn grey"
              :class="{ disabled: !connected || lightColor === 'grey' }"
              @click="emit('off')"
            >
              <i class="far fw fa-lightbulb"></i>OFF
            </span>
          </td>
          <td>
            <span
              class="btn red"
              :class="{ disabled: !connected || lightColor === 'red' }"
              @click="emit('red')"
            >
              <i class="fa fw fa-lightbulb"></i>적색등
            </span>
          </td>
        </tr>
      </table>
    </div>
  </article>
</template>

<style scoped>
table.buttons {
  margin-left: -0.5rem;
  text-align: center;
}

table.buttons td {
  padding: 0 0.5rem !important;
}
</style>
