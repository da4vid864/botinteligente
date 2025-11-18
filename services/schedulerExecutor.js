// services/schedulerExecutor.js
const schedulerService = require('./schedulerService');

let executorInterval = null;
let onActionCallback = null;

/**
 * Iniciar el ejecutor de tareas programadas
 * @param {Function} callback - Función que se ejecutará cuando haya una acción (enable/disable)
 */
function startSchedulerExecutor(callback) {
    if (executorInterval) {
        console.log('⚠️ El ejecutor de tareas ya está en funcionamiento');
        return;
    }

    onActionCallback = callback;

    // Revisar cada 30 segundos si hay tareas que ejecutar
    executorInterval = setInterval(() => {
        checkAndExecutePendingTasks();
    }, 30000); // 30 segundos

    console.log('✅ Ejecutor de tareas programadas iniciado');
    
    // Ejecutar inmediatamente la primera vez
    checkAndExecutePendingTasks();
}

/**
 * Detener el ejecutor
 */
function stopSchedulerExecutor() {
    if (executorInterval) {
        clearInterval(executorInterval);
        executorInterval = null;
        console.log('🛑 Ejecutor de tareas programadas detenido');
    }
}

/**
 * Revisar y ejecutar tareas pendientes
 */
function checkAndExecutePendingTasks() {
    const pendingTasks = schedulerService.getPendingSchedules();

    if (pendingTasks.length > 0) {
        console.log(`📅 Encontradas ${pendingTasks.length} tarea(s) pendiente(s) para ejecutar`);
    }

    pendingTasks.forEach(task => {
        try {
            console.log(`⚡ Ejecutando tarea programada: ${task.action} para bot ${task.botId}`);
            
            // Ejecutar la acción a través del callback
            if (onActionCallback) {
                onActionCallback(task.botId, task.action);
            }

            // Marcar como ejecutada
            schedulerService.markScheduleAsExecuted(task.id);
            
            console.log(`✅ Tarea ${task.id} ejecutada exitosamente`);
        } catch (error) {
            console.error(`❌ Error ejecutando tarea ${task.id}:`, error);
        }
    });
}

module.exports = {
    startSchedulerExecutor,
    stopSchedulerExecutor,
    checkAndExecutePendingTasks
};