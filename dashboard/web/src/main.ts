import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import "./style.css";

const root = document.querySelector<HTMLElement>("#app");

if (!root) {
  throw new Error("Missing #app root");
}

if (import.meta.hot?.data.app) {
  import.meta.hot.data.app.unmount();
  root.innerHTML = "";
}

const app = createApp(App);
app.use(createPinia());
app.mount(root);

if (import.meta.hot) {
  import.meta.hot.data.app = app;
  import.meta.hot.dispose((data) => {
    data.app = app;
  });
}
